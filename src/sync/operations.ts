import type { FileEntry, SyncAction, SyncOpType } from "../types";
import { resolveConflict } from "./merger";

/**
 * Individual sync operation detectors.
 * Each function is INDEPENDENT — takes (cloudList, localList) or (pendingDeletes) and returns SyncAction[].
 * No snapshot dependency — uses event-driven delete tracking instead.
 */

/** Index a file list by path for O(1) lookup */
function indexByPath(entries: FileEntry[]): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>();
  for (const e of entries) {
    map.set(e.path, e);
  }
  return map;
}

/**
 * Detect files that exist on BOTH sides with local being newer → push to cloud.
 */
export function detectLocalUpdates(
  cloudList: FileEntry[],
  localList: FileEntry[]
): SyncAction[] {
  const cloudMap = indexByPath(cloudList);
  const actions: SyncAction[] = [];
  for (const local of localList) {
    if (local.isFolder) continue;
    const cloud = cloudMap.get(local.path);
    if (!cloud || cloud.isFolder) continue;
    const decision = resolveConflict(local, cloud);
    if (decision === "local-update") {
      actions.push({
        operation: "local-update",
        path: local.path,
        isFolder: false,
        sourceEntry: local,
        cloudHash: cloud.hash,
        cloudMtime: cloud.mtime,
      });
    }
  }
  return actions;
}

/**
 * Detect files that exist on BOTH sides with cloud being newer → pull to local.
 */
export function detectCloudUpdates(
  cloudList: FileEntry[],
  localList: FileEntry[]
): SyncAction[] {
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];
  for (const cloud of cloudList) {
    if (cloud.isFolder) continue;
    const local = localMap.get(cloud.path);
    if (!local || local.isFolder) continue;
    const decision = resolveConflict(local, cloud);
    if (decision === "cloud-update") {
      actions.push({
        operation: "cloud-update",
        path: cloud.path,
        isFolder: false,
        sourceEntry: cloud,
      });
    }
  }
  return actions;
}

/**
 * Detect files in LOCAL only (not on cloud).
 * Without snapshot, all local-only files are treated as new → push to cloud.
 * Files in pendingCloudDeletes are excluded (those are intentional deletes).
 */
export function detectLocalAdds(
  cloudList: FileEntry[],
  localList: FileEntry[],
  pendingDeletes: { path: string; deletedAt: number }[] = []
): SyncAction[] {
  const cloudMap = indexByPath(cloudList);
  const deleteSet = new Set(pendingDeletes.map(d => d.path));
  const actions: SyncAction[] = [];
  for (const local of localList) {
    if (cloudMap.has(local.path)) continue;
    if (deleteSet.has(local.path)) continue; // user deleted then re-created? Unlikely but skip
    actions.push({
      operation: "local-add",
      path: local.path,
      isFolder: local.isFolder,
      sourceEntry: local,
    });
  }
  return actions;
}

/**
 * Detect files in CLOUD only (not on local).
 * Without snapshot, all cloud-only files are treated as new → pull to local.
 * Files in pendingCloudDeletes are excluded (we'll delete them from cloud instead).
 */
export function detectCloudAdds(
  cloudList: FileEntry[],
  localList: FileEntry[],
  pendingDeletes: { path: string; deletedAt: number }[] = []
): SyncAction[] {
  const localMap = indexByPath(localList);
  const deleteSet = new Set(pendingDeletes.map(d => d.path));
  // Collect deleted folder prefixes to block re-adding children
  const deletedFolderPrefixes = pendingDeletes
    .filter(d => d.path.endsWith("/"))
    .map(d => d.path);
  const actions: SyncAction[] = [];
  for (const cloud of cloudList) {
    if (localMap.has(cloud.path)) continue;
    if (deleteSet.has(cloud.path)) continue; // this file was locally deleted → will be handled by local-delete
    if (deletedFolderPrefixes.some(fp => cloud.path.startsWith(fp))) continue; // parent folder was deleted
    actions.push({
      operation: "cloud-add",
      path: cloud.path,
      isFolder: cloud.isFolder,
      sourceEntry: cloud,
    });
  }
  return actions;
}

/**
 * Detect files that were deleted locally (tracked via vault.on("delete")).
 * Safety: if cloud file was modified AFTER local deletion, re-download instead of deleting.
 */
export function detectLocalDeletes(
  cloudList: FileEntry[],
  _localList: FileEntry[],
  pendingDeletes: { path: string; deletedAt: number }[] = []
): SyncAction[] {
  const cloudMap = indexByPath(cloudList);
  const actions: SyncAction[] = [];
  for (const { path: deletedPath, deletedAt } of pendingDeletes) {
    const cloud = cloudMap.get(deletedPath);
    if (!cloud) continue; // already gone from cloud → no action
    if (cloud.mtime > deletedAt) {
      // Cloud file was modified AFTER local deletion → re-download to local instead
      actions.push({
        operation: "cloud-add",
        path: deletedPath,
        isFolder: cloud.isFolder,
        sourceEntry: cloud,
      });
    } else {
      // Cloud file not modified since deletion → safe to delete from cloud
      actions.push({
        operation: "local-delete",
        path: deletedPath,
        isFolder: cloud.isFolder,
        sourceEntry: cloud,
      });
    }
  }
  return actions;
}

/**
 * Detect files deleted on cloud (via delta API) that should be trashed locally.
 * cloudDeletedPaths comes from provider.getDeletedItems() — paths deleted on cloud since last sync.
 * Only deletes locally if the file is NOT on cloud AND exists locally.
 */
export function detectCloudDeletes(
  cloudList: FileEntry[],
  localList: FileEntry[],
  _pendingDeletes: { path: string; deletedAt: number }[] = [],
  cloudDeletedPaths: string[] = []
): SyncAction[] {
  if (cloudDeletedPaths.length === 0) return [];
  const cloudMap = indexByPath(cloudList);
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];
  for (const deletedPath of cloudDeletedPaths) {
    // Only act if the file no longer exists on cloud AND still exists locally
    if (cloudMap.has(deletedPath)) continue; // re-created on cloud — skip
    const local = localMap.get(deletedPath);
    if (!local) continue; // already gone locally — skip
    actions.push({
      operation: "cloud-delete",
      path: deletedPath,
      isFolder: local.isFolder,
      sourceEntry: local,
    });
  }
  return actions;
}

/** Pending delete entry type */
export type PendingDelete = { path: string; deletedAt: number };

/** Map of operation type to its detector function */
export const OPERATION_DETECTORS: Record<
  SyncOpType,
  (cloud: FileEntry[], local: FileEntry[], pendingDeletes: PendingDelete[], cloudDeletedPaths?: string[]) => SyncAction[]
> = {
  "local-update": (c, l, _p) => detectLocalUpdates(c, l),
  "cloud-update": (c, l, _p) => detectCloudUpdates(c, l),
  "local-add": detectLocalAdds,
  "cloud-add": detectCloudAdds,
  "local-delete": detectLocalDeletes,
  "cloud-delete": detectCloudDeletes,
};
