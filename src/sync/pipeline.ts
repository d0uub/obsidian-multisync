import type { App } from "obsidian";
import type {
  FileEntry,
  SyncAction,
  SyncStep,
  SyncRule,
  CloudAccount,
  MultiSyncSettings,
} from "../types";
import type { ICloudProvider, DeltaChange } from "../providers/ICloudProvider";
import { OPERATION_DETECTORS } from "./operations";
import { normalizePath } from "../utils/helpers";
import { computeLocalHash } from "../utils/hashing";
import {
  saveCloudRegistry,
  loadCloudRegistry,
  applyDeltaChanges,
  buildIdToPathMap,
  type CloudFileEntry,
} from "../utils/cloudRegistry";

const OP_LABELS: Record<string, string> = {
  "local-add": "Add",
  "cloud-add": "Add",
  "local-update": "Update",
  "cloud-update": "Update",
  "local-delete": "Delete",
  "cloud-delete": "Delete",
};

/** ↑ = toward cloud, ↓ = toward local */
const OP_ARROW: Record<string, string> = {
  "local-add": "↑",
  "cloud-add": "↓",
  "local-update": "↑",
  "cloud-update": "↓",
  "local-delete": "↑",
  "cloud-delete": "↓",
};

/** Destination icon: ☁ = cloud, 📁 = local */
const OP_DEST: Record<string, string> = {
  "local-add": "☁",
  "cloud-add": "📁",
  "local-update": "☁",
  "cloud-update": "📁",
  "local-delete": "☁",
  "cloud-delete": "📁",
};

/**
 * SyncPipeline orchestrator.
 * Executes an ordered array of SyncStep (ruleId + operation).
 * Uses account-level delta sync with manifest-based delete detection.
 */

export interface PipelineContext {
  app: App;
  settings: MultiSyncSettings;
  providers: Map<string, ICloudProvider>;
  /** Callback to persist settings */
  saveSettings: () => Promise<void>;
  onProgress?: (msg: string) => void;
  onAction?: (action: SyncAction, step: SyncStep) => void;
  dryRun?: boolean;
}

interface ListCache {
  cloudList: FileEntry[];
  localList: FileEntry[];
}

export async function runPipeline(
  steps: SyncStep[],
  ctx: PipelineContext
): Promise<{ actionsExecuted: number; errors: string[] }> {
  const listCaches = new Map<string, ListCache>();
  let actionsExecuted = 0;
  const errors: string[] = [];

  // ── 1. Account-level delta sync ──────────────────────────────────
  // For each unique account referenced in the pipeline steps, call
  // syncAccountDelta() once to get changes since last sync (or full
  // enumeration on first run), then apply them to the IndexedDB registry.
  // The pre-delta registry serves as the 3-way sync base (what was on
  // cloud after the last successful sync).
  const accountRegistries = new Map<string, CloudFileEntry[]>();
  const accountBases = new Map<string, CloudFileEntry[]>();
  const accountDeltas = new Map<string, DeltaChange[]>();
  const processedAccounts = new Set<string>();

  for (const step of steps) {
    const rule = ctx.settings.rules.find((r) => r.id === step.ruleId);
    if (!rule) continue;
    const account = ctx.settings.accounts.find((a) => a.id === rule.accountId);
    if (!account || processedAccounts.has(account.id)) continue;
    processedAccounts.add(account.id);

    const provider = ctx.providers.get(account.id);
    if (!provider) continue;

    try {
      // Load pre-delta registry as 3-way sync base
      const base = await loadCloudRegistry(account.id);
      accountBases.set(account.id, base);

      const deltaToken = ctx.settings.deltaTokens?.[account.id] || "";
      const result = await provider.syncAccountDelta(deltaToken);

      // Resolve missing paths on deleted entries using the pre-delta registry.
      // OneDrive delta often omits name/parentReference for deleted items.
      if (!result.isFullEnum && base.length > 0) {
        const idToPath = buildIdToPathMap(base);
        for (const c of result.changes) {
          if (c.deleted && !c.path && c.id) {
            c.path = idToPath[c.id];
          }
        }
      }

      // Apply changes to registry (full replace or incremental merge)
      const registry = await applyDeltaChanges(account.id, result.changes, result.isFullEnum);
      accountRegistries.set(account.id, registry);
      accountDeltas.set(account.id, result.changes);

      // Persist new delta token
      if (!ctx.settings.deltaTokens) ctx.settings.deltaTokens = {};
      ctx.settings.deltaTokens[account.id] = result.newDeltaToken;
      await ctx.saveSettings();
    } catch (e: any) {
      errors.push(`Failed to sync delta for ${account.name}: ${e?.message || e}`);
    }
  }

  for (const step of steps) {
    try {
      const rule = ctx.settings.rules.find((r) => r.id === step.ruleId);
      if (!rule) { errors.push(`Rule not found: ${step.ruleId}`); continue; }

      const account = ctx.settings.accounts.find((a) => a.id === rule.accountId);
      if (!account) { errors.push(`Account not found: ${rule.accountId}`); continue; }

      const provider = ctx.providers.get(account.id);
      if (!provider) { errors.push(`Provider not initialized for account: ${account.name}`); continue; }

      const cache = await getOrFetchLists(rule, provider, ctx, listCaches, accountRegistries, account);

      const detector = OPERATION_DETECTORS[step.operation];
      if (!detector) { errors.push(`Unknown operation: ${step.operation}`); continue; }

      // Derive cloud-deleted paths from account delta for this rule's cloud folder
      const cloudDeletedPaths = getDeletedPathsForRule(accountDeltas.get(account.id) || [], rule.cloudFolder);

      // Build 3-way sync base from pre-delta registry (what was synced last time)
      const base = accountBases.get(account.id) || [];
      const basePaths = buildBaseForRule(base, rule.cloudFolder);

      let actions = detector(cache.cloudList, cache.localList, cloudDeletedPaths, basePaths);

      // For delete operations, prune children whose parent folder is also being deleted
      if (step.operation === "local-delete" || step.operation === "cloud-delete") {
        actions = pruneRedundantDeletes(actions);
      }

      // Execute actions concurrently
      const concurrency = ctx.settings.concurrency || 4;
      let pendingSaves = 0;
      let stepExecuted = 0;
      let i = 0;
      const runNext = async (): Promise<void> => {
        while (i < actions.length) {
          const action = actions[i++];
          try {
            const arrow = OP_ARROW[action.operation] || "";
            const opLabel = OP_LABELS[action.operation] || action.operation;
            const typeMap: Record<string, string> = { dropbox: "Dropbox", onedrive: "OneDrive", gdrive: "GDrive" };
            const accountType = account.type ? ` (${typeMap[account.type] || account.type})` : "";
            ctx.onAction?.(action, step);
            // Destination-based path: cloud ops show cloud path, local ops show local path
            const dest = OP_DEST[action.operation] || "";
            const isToCloud = ["local-add", "local-update", "local-delete"].includes(action.operation);
            const destPath = isToCloud
              ? `${rule.cloudFolder}/${action.path}`
              : `${rule.localFolder}/${action.path}`;
            console.log(`${arrow} ${account.name}${accountType} ${opLabel}: ${dest} ${destPath}`);
            if (!ctx.dryRun) {
              const executed = await executeAction(action, rule, provider, ctx);
              if (!executed) continue; // hash match — skipped
              stepExecuted++;
              pendingSaves++;
              if (pendingSaves >= 20) {
                pendingSaves = 0;
                await ctx.saveSettings();
              }
            }
            actionsExecuted++;
          } catch (e: any) {
            const detail = e?.status ? `status ${e.status}` : (e?.message || e);
            const errLabel = OP_LABELS[action.operation] || action.operation;
            const errArrow = OP_ARROW[action.operation] || "";
            errors.push(`${errLabel} ${action.path}: ${detail}`);
            console.error(`${errArrow} ERROR ${errLabel}: ${action.path} — ${detail}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, actions.length) }, () => runNext()));
      if (pendingSaves > 0 && !ctx.dryRun) {
        await ctx.saveSettings();
      }

      // Partial cache invalidation: only re-list what actually changed
      if (stepExecuted > 0 && !ctx.dryRun) {
        // After cloud-delete, clean up empty local folders left behind
        if (step.operation === "cloud-delete") {
          await cleanupEmptyFolders(ctx.app, rule.localFolder);
        }
        const cached = listCaches.get(rule.id);
        if (cached) {
          if (step.operation === "cloud-add" || step.operation === "cloud-update" || step.operation === "cloud-delete") {
            // Only local changed → re-fetch local list, keep cloud list
            cached.localList = await listLocalFiles(ctx.app, rule.localFolder);
          } else {
            // local-add, local-update, local-delete → cloud changed
            // Re-list cloud folder and update in-memory registry
            cached.cloudList = await provider.listFiles(rule.cloudFolder);
            // Update account registry in memory for subsequent rules sharing this account
            updateAccountRegistryFromCloudList(accountRegistries, account.id, rule.cloudFolder, cached.cloudList);
          }
        }
      }
    } catch (e: any) {
      errors.push(`${OP_LABELS[step.operation] || step.operation}: ${e?.message || e}`);
    }
  }

  // Save final account registries to IndexedDB after all steps complete.
  if (!ctx.dryRun) {
    const savedAccountIds = new Set<string>();
    const processedRuleIds = new Set(steps.map(s => s.ruleId));
    for (const ruleId of processedRuleIds) {
      const rule = ctx.settings.rules.find(r => r.id === ruleId);
      if (rule && !savedAccountIds.has(rule.accountId)) {
        savedAccountIds.add(rule.accountId);
        const registry = accountRegistries.get(rule.accountId);
        if (registry && registry.length > 0) {
          await saveCloudRegistry(rule.accountId, registry);
        }
      }
    }
  }

  return { actionsExecuted, errors };
}

/** Execute a single sync action. Returns true if actually executed, false if skipped (hash match). */
async function executeAction(
  action: SyncAction,
  rule: SyncRule,
  provider: ICloudProvider,
  ctx: PipelineContext
): Promise<boolean> {
  const { app } = ctx;
  const normalizedBase = normalizePath(rule.localFolder);

  /** Build vault path from relative sync path */
  const toVaultPath = (relativePath: string) =>
    normalizedBase ? `${normalizedBase}/${relativePath}` : relativePath;

  switch (action.operation) {
    case "local-update": {
      // Local file is newer → push to cloud
      const localPath = toVaultPath(action.path);
      const content = await app.vault.adapter.readBinary(localPath);
      // Hash check: skip upload if content matches cloud
      if (action.cloudHash) {
        const localHash = await computeLocalHash(provider.kind, content);
        if (localHash && localHash === action.cloudHash) {
          ctx.onProgress?.(`Skip ${action.path} (unchanged)`);
          if (action.cloudMtime) {
            try { await app.vault.adapter.writeBinary(localPath, content, { mtime: action.cloudMtime }); } catch { /* best effort */ }
          }
          return false;
        }
      }
      await provider.writeFile(
        rule.cloudFolder,
        action.path,
        content,
        action.sourceEntry?.mtime || Date.now(),
        action.sourceEntry?.ctime
      );
      break;
    }
    case "cloud-update": {
      // Cloud file is newer → pull to local
      // Hash check: read local file first, compare hash to skip download
      const localPathUpd = toVaultPath(action.path);
      if (action.sourceEntry?.hash) {
        try {
          const localContent = await app.vault.adapter.readBinary(localPathUpd);
          const localHash = await computeLocalHash(provider.kind, localContent);
          if (localHash && localHash === action.sourceEntry.hash) {
            ctx.onProgress?.(`Skip ${action.path} (unchanged)`);
            const cloudMtime = action.sourceEntry.mtime;
            if (cloudMtime) {
              try { await app.vault.adapter.writeBinary(localPathUpd, localContent, { mtime: cloudMtime }); } catch { /* best effort */ }
            }
            return false;
          }
        } catch { /* file may not exist yet, proceed with download */ }
      }
      const content = await provider.readFile(rule.cloudFolder, action.path);
      await ensureLocalParentDir(app, localPathUpd);
      const mtime = action.sourceEntry?.mtime || Date.now();
      const ctime = action.sourceEntry?.ctime;
      await app.vault.adapter.writeBinary(localPathUpd, content, { mtime, ...(ctime ? { ctime } : {}) });
      break;
    }
    case "local-add": {
      if (action.isFolder) {
        await provider.mkdir(rule.cloudFolder, action.path.replace(/\/$/, ""));
      } else {
        const localPath = toVaultPath(action.path);
        const content = await app.vault.adapter.readBinary(localPath);
        await provider.writeFile(
          rule.cloudFolder,
          action.path,
          content,
          action.sourceEntry?.mtime || Date.now(),
          action.sourceEntry?.ctime
        );
      }
      break;
    }
    case "cloud-add": {
      if (action.isFolder) {
        const localPath = toVaultPath(action.path);
        await ensureLocalParentDir(app, localPath.replace(/\/$/, "") + "/dummy");
      } else {
        const content = await provider.readFile(rule.cloudFolder, action.path);
        const localPath = toVaultPath(action.path);
        await ensureLocalParentDir(app, localPath);
        const mtime = action.sourceEntry?.mtime || Date.now();
        const ctime = action.sourceEntry?.ctime;
        await app.vault.adapter.writeBinary(localPath, content, { mtime, ...(ctime ? { ctime } : {}) });
      }
      break;
    }
    case "local-delete": {
      // Local deleted → delete from cloud
      await provider.deleteFile(rule.cloudFolder, action.path.replace(/\/$/, ""));
      break;
    }
    case "cloud-delete": {
      // Cloud deleted → move local to trash
      const localPath = toVaultPath(action.path);
      const cleanPath = localPath.replace(/\/$/, "");
      const abstractFile = ctx.app.vault.getAbstractFileByPath(cleanPath);
      if (abstractFile) {
        try {
          await ctx.app.vault.trash(abstractFile, true);
        } catch (e: any) {
          if (e?.message?.includes("ENOENT")) break; // already gone
          throw e;
        }
      }
      break;
    }
  }
  return true;
}

/** List local files under a vault folder, returning FileEntry[] with paths relative to that folder */
export async function listLocalFiles(
  app: App,
  localFolder: string
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  const files = app.vault.getFiles();
  const normalized = normalizePath(localFolder);
  const prefix = normalized ? normalized + "/" : "";

  for (const file of files) {
    const filePath = normalizePath(file.path);
    if (prefix && !filePath.startsWith(prefix)) continue;
    const relativePath = prefix ? filePath.substring(prefix.length) : filePath;
    if (!relativePath) continue;
    entries.push({
      path: relativePath,
      mtime: file.stat.mtime,
      size: file.stat.size,
      isFolder: false,
      ctime: file.stat.ctime,
    });
  }

  // Also include folders
  const allFolders = app.vault.getAllFolders();
  for (const folder of allFolders) {
    const folderPath = normalizePath(folder.path);
    if (prefix && !folderPath.startsWith(prefix)) continue;
    const relativePath = prefix
      ? folderPath.substring(prefix.length)
      : folderPath;
    if (!relativePath) continue;
    entries.push({
      path: relativePath + "/",
      mtime: 0,
      size: 0,
      isFolder: true,
    });
  }

  return entries;
}

/** Ensure parent directories exist for a local file path */
async function ensureLocalParentDir(app: App, filePath: string): Promise<void> {
  const parts = normalizePath(filePath).split("/");
  parts.pop(); // remove filename
  if (parts.length === 0) return;
  const dirPath = parts.join("/");
  if (!(await app.vault.adapter.exists(dirPath))) {
    await app.vault.adapter.mkdir(dirPath);
  }
}

/** Fetch and cache file lists for a rule.
 *  Cloud list is derived from the account registry (filtered by cloudFolder).
 *  Falls back to provider.listFiles() if registry is empty. */
async function getOrFetchLists(
  rule: SyncRule,
  provider: ICloudProvider,
  ctx: PipelineContext,
  cache: Map<string, ListCache>,
  accountRegistries: Map<string, CloudFileEntry[]>,
  account: CloudAccount
): Promise<ListCache> {
  if (cache.has(rule.id)) return cache.get(rule.id)!;

  const localList = await listLocalFiles(ctx.app, rule.localFolder);

  // Derive cloud list from account registry, filtered by cloud folder
  const registry = accountRegistries.get(account.id);
  let cloudList: FileEntry[];
  if (registry && registry.length > 0) {
    cloudList = filterRegistryByFolder(registry, rule.cloudFolder);
  } else {
    // Fallback: no registry yet (e.g. delta failed), use listFiles
    cloudList = await provider.listFiles(rule.cloudFolder);
  }

  const entry: ListCache = { cloudList, localList };
  cache.set(rule.id, entry);
  return entry;
}

/** Filter account-level registry entries to a specific cloud folder, returning FileEntry[] with relative paths */
function filterRegistryByFolder(registry: CloudFileEntry[], cloudFolder: string): FileEntry[] {
  const prefix = (!cloudFolder || cloudFolder === "/")
    ? ""
    : (cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder);

  const entries: FileEntry[] = [];
  for (const e of registry) {
    let relativePath: string;
    if (prefix) {
      const withSlash = prefix + "/";
      if (!e.path.startsWith(withSlash) && e.path !== prefix && !e.path.startsWith(withSlash.replace(/\/$/, "") + "/")) continue;
      // Strip the folder prefix and the trailing slash for folders with exact prefix match
      if (e.path.startsWith(withSlash)) {
        relativePath = e.path.substring(withSlash.length);
      } else {
        continue;
      }
    } else {
      relativePath = e.path;
    }
    if (!relativePath) continue;

    entries.push({
      path: relativePath,
      mtime: e.mtime,
      size: e.size,
      isFolder: e.isFolder,
      hash: e.hash,
      ctime: e.ctime,
      cloudId: e.id,
    });
  }
  return entries;
}

/** Extract deleted file paths relevant to a specific cloud folder from account-level delta changes */
function getDeletedPathsForRule(changes: DeltaChange[], cloudFolder: string): string[] {
  const prefix = (!cloudFolder || cloudFolder === "/")
    ? ""
    : (cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder);
  const withSlash = prefix ? prefix + "/" : "";
  const deleted: string[] = [];

  for (const c of changes) {
    if (!c.deleted || !c.path) continue;
    if (prefix) {
      if (!c.path.startsWith(withSlash)) continue;
      const rel = c.path.substring(withSlash.length);
      if (rel) deleted.push(rel);
    } else {
      deleted.push(c.path);
    }
  }
  return deleted;
}

/** Build the 3-way sync base for a rule from the pre-delta account registry.
 *  Returns a Set of relative paths that were in the registry for this rule's cloud folder. */
function buildBaseForRule(registry: CloudFileEntry[], cloudFolder: string): Set<string> | null {
  if (registry.length === 0) return null; // first sync, no base

  const prefix = (!cloudFolder || cloudFolder === "/")
    ? ""
    : (cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder);
  const withSlash = prefix ? prefix + "/" : "";
  const paths = new Set<string>();

  for (const e of registry) {
    if (prefix) {
      if (!e.path.startsWith(withSlash)) continue;
      const rel = e.path.substring(withSlash.length);
      if (rel) paths.add(rel);
    } else {
      paths.add(e.path);
    }
  }

  return paths.size > 0 ? paths : null;
}

/** Update in-memory account registry when a rule's cloud folder is re-listed after changes */
function updateAccountRegistryFromCloudList(
  accountRegistries: Map<string, CloudFileEntry[]>,
  accountId: string,
  cloudFolder: string,
  cloudList: FileEntry[]
): void {
  const registry = accountRegistries.get(accountId);
  if (!registry) return;

  const prefix = (!cloudFolder || cloudFolder === "/")
    ? ""
    : (cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder);
  const withSlash = prefix ? prefix + "/" : "";

  // Remove old entries under this folder
  const filtered = prefix
    ? registry.filter(e => !e.path.startsWith(withSlash))
    : [];

  // Add new entries from cloudList (convert FileEntry → CloudFileEntry)
  for (const e of cloudList) {
    const fullPath = prefix ? `${prefix}/${e.path}` : e.path;
    filtered.push({
      id: e.cloudId || fullPath,
      path: fullPath,
      mtime: e.mtime,
      size: e.size,
      isFolder: e.isFolder,
      hash: e.hash,
      ctime: e.ctime,
    });
  }

  accountRegistries.set(accountId, filtered);
}

/** After cloud-delete removes files, trash any sub-folders that are now empty.
 *  Walks deepest-first so nested empty folders are cleaned bottom-up. */
async function cleanupEmptyFolders(app: App, localFolder: string): Promise<void> {
  const normalized = normalizePath(localFolder);
  const allFolders = app.vault.getAllFolders()
    .filter(f => {
      const fp = normalizePath(f.path);
      return normalized ? fp.startsWith(normalized + "/") : fp.length > 0;
    })
    .sort((a, b) => b.path.length - a.path.length); // deepest first

  for (const folder of allFolders) {
    const listed = await app.vault.adapter.list(folder.path);
    if ((listed.files || []).length === 0 && (listed.folders || []).length === 0) {
      try {
        await app.vault.trash(folder, true);
      } catch { /* best effort */ }
    }
  }
}

/** Remove delete actions for files/folders whose parent folder is also being deleted.
 *  Deleting a folder recursively removes all children, so individual child deletes are redundant. */
function pruneRedundantDeletes(actions: SyncAction[]): SyncAction[] {
  // Collect folder paths being deleted (without trailing slash for prefix matching)
  const deletedFolders = new Set<string>();
  for (const a of actions) {
    if (a.isFolder) {
      deletedFolders.add(a.path.replace(/\/$/, "") + "/");
    }
  }
  if (deletedFolders.size === 0) return actions;

  return actions.filter(a => {
    // Keep folder deletes, but check if a parent folder is also being deleted
    for (const folder of deletedFolders) {
      if (a.path !== folder && a.path.startsWith(folder)) return false;
      // Also check for nested folder deletes: "sub/" inside "parent/sub/"
      const cleanPath = a.isFolder ? a.path.replace(/\/$/, "") + "/" : a.path;
      if (cleanPath !== folder && cleanPath.startsWith(folder)) return false;
    }
    return true;
  });
}
