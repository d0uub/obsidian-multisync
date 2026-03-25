/**
 * CloudRegistry — IndexedDB-backed per-account cloud file registry.
 *
 * Stores the full cloud file list (id, path, mtime, size, hash, ctime)
 * for each cloud account. Used primarily to resolve deleted-item IDs
 * back to file paths when the cloud delta API doesn't provide a path.
 *
 * One IndexedDB database "multisync-cloud-registry", one object store "accounts".
 * Each record: key = accountId, value = CloudFileEntry[].
 */

import { normalizeRelativePath } from "./helpers";

export interface CloudFileEntry {
  /** Cloud-provider-specific unique ID (e.g. OneDrive item ID) */
  id: string;
  /** Relative path from sync root */
  path: string;
  /** Last modified timestamp in ms */
  mtime: number;
  /** File size in bytes */
  size: number;
  /** True if folder */
  isFolder: boolean;
  /** Content hash (provider-specific) */
  hash?: string;
  /** Creation timestamp in ms */
  ctime?: number;
}

/** Wrapper stored in IndexedDB: file entries + sync timestamp */
export interface CloudRegistryRecord {
  entries: CloudFileEntry[];
  /** Epoch ms when this registry was last saved (i.e. last successful sync) */
  lastSyncAt: number;
  /** Files that exist on cloud but cannot be synced (native format, too large, etc.) */
  unsyncable?: { path: string; name: string; size: number; reason: string }[];
}

const DB_NAME = "multisync-cloud-registry";
const STORE_NAME = "accounts";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

/** Save the full cloud file list for an account (records sync timestamp). */
export async function saveCloudRegistry(
  accountId: string,
  entries: CloudFileEntry[],
  unsyncable?: { path: string; name: string; size: number; reason: string }[]
): Promise<void> {
  // Normalize paths to prevent leading-slash or double-slash issues from providers
  for (const e of entries) e.path = normalizeRelativePath(e.path);
  const record: CloudRegistryRecord = { entries, lastSyncAt: Date.now(), unsyncable: unsyncable || [] };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record, accountId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("IndexedDB transaction failed")); };
  });
}

/** Load the cloud file list for an account. Returns empty array if not found. */
export async function loadCloudRegistry(accountId: string): Promise<CloudFileEntry[]> {
  const raw = await loadCloudRegistryRaw(accountId);
  // Backward compat: old records are bare arrays, new ones are { entries, lastSyncAt }
  if (Array.isArray(raw)) return raw;
  return raw?.entries || [];
}

/** Load the raw registry record (entries + metadata). */
async function loadCloudRegistryRaw(accountId: string): Promise<CloudRegistryRecord | CloudFileEntry[] | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(accountId);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error ?? new Error("IndexedDB read failed")); };
  });
}

/** Get the last sync timestamp (epoch ms) for an account. Returns null if never synced. */
export async function getLastSyncTime(accountId: string): Promise<number | null> {
  const raw = await loadCloudRegistryRaw(accountId);
  if (raw && !Array.isArray(raw) && raw.lastSyncAt) return raw.lastSyncAt;
  return null;
}

/** Delete the registry for an account. */
export async function deleteCloudRegistry(accountId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(accountId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("IndexedDB delete failed")); };
  });
}

/** Build an id→path lookup map from a registry. */
export function buildIdToPathMap(entries: CloudFileEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entries) {
    if (e.id) map[e.id] = e.path;
  }
  return map;
}

/** Load unsyncable files for an account. Returns empty array if not found. */
export async function loadUnsyncableFiles(accountId: string): Promise<{ path: string; name: string; size: number; reason: string }[]> {
  const raw = await loadCloudRegistryRaw(accountId);
  if (!raw || Array.isArray(raw)) return [];
  return raw.unsyncable || [];
}

/**
 * Apply delta changes to the stored registry for an account.
 * If isFullEnum is true, the changes represent the complete file list (replaces stored list).
 * Otherwise, merges incrementally: deletes remove by id, non-deletes upsert by id.
 * Saves the updated list and returns it.
 */
export async function applyDeltaChanges(
  accountId: string,
  changes: import("../providers/ICloudProvider").DeltaChange[],
  isFullEnum: boolean
): Promise<CloudFileEntry[]> {
  let entries: CloudFileEntry[];

  if (isFullEnum) {
    // Full enum — build list from non-deleted changes only
    entries = [];
    for (const c of changes) {
      if (!c.deleted && c.entry) entries.push(c.entry);
    }
  } else {
    // Incremental — load existing, apply changes
    entries = await loadCloudRegistry(accountId);
    const byId = new Map<string, CloudFileEntry>();
    for (const e of entries) byId.set(e.id, e);

    // Also index by path for deletion matching (some providers don't include ID in delete entries)
    const idByPath = new Map<string, string>();
    for (const e of entries) idByPath.set(e.path, e.id);

    for (const c of changes) {
      if (c.deleted) {
        // Try by ID first, then fall back to path lookup
        if (byId.has(c.id)) {
          byId.delete(c.id);
        } else if (c.path) {
          // Match by path (exact or with/without trailing slash for folders)
          const existingId = idByPath.get(c.path) || idByPath.get(c.path + "/");
          if (existingId) byId.delete(existingId);
        }
      } else if (c.entry) {
        // If hash matches existing entry, keep the existing mtime
        // (avoids false-positive updates when cloud mtime changes without content change)
        const existing = byId.get(c.id);
        if (existing && c.entry.hash && existing.hash === c.entry.hash) {
          byId.set(c.id, { ...c.entry, mtime: existing.mtime });
        } else {
          byId.set(c.id, c.entry);
        }
      }
    }
    entries = Array.from(byId.values());
  }

  await saveCloudRegistry(accountId, entries);
  return entries;
}
