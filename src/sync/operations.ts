import type { FileEntry, SyncAction, SyncOpType } from "../types";
import { resolveConflict } from "./merger";

/**
 * Individual sync operation detectors.
 * Each function is INDEPENDENT — takes (cloudList, localList) and returns SyncAction[].
 * Uses manifest-based delete detection and account-level delta sync.
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
 * Files in syncBase (previously synced) that are missing from cloud are treated as cloud-deleted (not new).
 * Files in cloudDeletedPaths (from delta) are also excluded.
 */
export function detectLocalAdds(
  cloudList: FileEntry[],
  localList: FileEntry[],
  _cloudDeletedPaths: string[] = [],
  syncBase: Set<string> | null = null
): SyncAction[] {
  const cloudMap = indexByPath(cloudList);
  const actions: SyncAction[] = [];
  for (const local of localList) {
    if (cloudMap.has(local.path)) continue;
    // File was previously synced but now missing from cloud → cloud-deleted, don't re-upload
    if (syncBase && syncBase.has(local.path)) continue;
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
 * Files in syncBase that are missing locally are treated as local-deleted (not new).
 */
export function detectCloudAdds(
  cloudList: FileEntry[],
  localList: FileEntry[],
  _cloudDeletedPaths: string[] = [],
  syncBase: Set<string> | null = null
): SyncAction[] {
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];
  for (const cloud of cloudList) {
    if (localMap.has(cloud.path)) continue;
    // File was previously synced but now missing locally → locally deleted, don't re-download
    if (syncBase && syncBase.has(cloud.path)) continue;
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
 * Detect files that were deleted locally by comparing current local list against syncBase.
 * A file in the base (previously synced) that is missing locally AND still on cloud = local deletion.
 */
export function detectLocalDeletes(
  cloudList: FileEntry[],
  localList: FileEntry[],
  _cloudDeletedPaths: string[] = [],
  syncBase: Set<string> | null = null
): SyncAction[] {
  if (!syncBase || syncBase.size === 0) return []; // first sync, no deletions possible
  const cloudMap = indexByPath(cloudList);
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];
  for (const basePath of syncBase) {
    if (localMap.has(basePath)) continue; // still exists locally
    const cloud = cloudMap.get(basePath);
    if (!cloud) continue; // already gone from cloud too
    // Was synced before, now missing locally, still on cloud → local deletion
    actions.push({
      operation: "local-delete",
      path: basePath,
      isFolder: cloud.isFolder,
      sourceEntry: cloud,
    });
  }
  return actions;
}

/**
 * Detect files deleted on cloud (via delta API) that should be trashed locally.
 * cloudDeletedPaths comes from the account delta:
 *   - Specific paths: files confirmed deleted by the delta API
 *   - ["*"]: delta detected deletions but couldn't extract names → diff-based detection
 * Only deletes locally if the file is NOT on cloud AND exists locally.
 * In diff mode, uses syncBase to only flag files that were previously synced.
 */
export function detectCloudDeletes(
  cloudList: FileEntry[],
  localList: FileEntry[],
  cloudDeletedPaths: string[] = [],
  syncBase: Set<string> | null = null
): SyncAction[] {
  if (cloudDeletedPaths.length === 0) return [];
  // Without a base, we can't distinguish "cloud-deleted" from "never synced" — skip all deletes
  if (!syncBase || syncBase.size === 0) return [];
  const cloudMap = indexByPath(cloudList);
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];

  // "*" sentinel = delta saw deletions but couldn't extract filenames → diff-based detection with base guard.
  const diffMode = cloudDeletedPaths.length === 1 && cloudDeletedPaths[0] === "*";

  if (diffMode) {
    for (const [localPath, local] of localMap) {
      if (local.isFolder) continue;
      if (cloudMap.has(localPath)) continue; // still on cloud
      if (!syncBase.has(localPath)) continue; // never synced → new local file
      actions.push({
        operation: "cloud-delete",
        path: localPath,
        isFolder: false,
        sourceEntry: local,
      });
    }
  } else {
    for (const deletedPath of cloudDeletedPaths) {
      if (cloudMap.has(deletedPath)) continue; // re-created on cloud — skip
      // Try exact match, then with/without trailing slash for folders
      let local = localMap.get(deletedPath);
      if (!local) local = localMap.get(deletedPath + "/");
      if (!local) local = localMap.get(deletedPath.replace(/\/$/, ""));
      if (!local) continue; // already gone locally — skip
      const basePath = syncBase.has(deletedPath) || syncBase.has(deletedPath + "/") || syncBase.has(deletedPath.replace(/\/$/, ""));
      if (!basePath) continue; // never synced → new local file
      actions.push({
        operation: "cloud-delete",
        path: local.path, // Use the actual local path (with correct trailing slash)
        isFolder: local.isFolder,
        sourceEntry: local,
      });
    }
  }
  return actions;
}

/** Map of operation type to its detector function */
export const OPERATION_DETECTORS: Record<
  SyncOpType,
  (cloud: FileEntry[], local: FileEntry[], cloudDeletedPaths?: string[], syncBase?: Set<string> | null) => SyncAction[]
> = {
  "local-update": (c, l) => detectLocalUpdates(c, l),
  "cloud-update": (c, l) => detectCloudUpdates(c, l),
  "local-add": detectLocalAdds,
  "cloud-add": detectCloudAdds,
  "local-delete": detectLocalDeletes,
  "cloud-delete": detectCloudDeletes,
};
