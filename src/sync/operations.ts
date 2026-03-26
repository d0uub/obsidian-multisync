import type { FileEntry, SyncAction, SyncOpType } from "../types";
import { resolveConflict } from "./merger";

/**
 * 3-way sync operation detectors.
 *
 * Every detector takes (cloudList, localList, base) where base is the
 * IndexedDB registry snapshot from the last successful sync.
 *
 * Decision matrix per file path:
 *   local  cloud  base  → action
 *   ───────────────────────────────
 *   ✓      ✗      ✗     → local-add     (new local file)
 *   ✗      ✓      ✗     → cloud-add     (new cloud file)
 *   ✓      ✓      -     → update        (mtime comparison)
 *   ✓      ✗      ✓     → cloud-delete  (was synced, gone from cloud → trash local)
 *   ✗      ✓      ✓     → local-delete  (was synced, gone from local → delete cloud)
 *   ✗      ✗      ✓     → nothing       (deleted on both sides)
 */

/** Index by lowercase path for O(1) case-insensitive lookup */
function indexByPath(entries: FileEntry[]): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>();
  for (const e of entries) map.set(e.path.toLowerCase(), e);
  return map;
}

function getPath(map: Map<string, FileEntry>, path: string): FileEntry | undefined {
  return map.get(path.toLowerCase());
}

/** Detect files on BOTH sides where local is newer → push to cloud */
export function detectLocalUpdates(
  cloudList: FileEntry[], localList: FileEntry[], _base: Set<string> | null
): SyncAction[] {
  const cloudMap = indexByPath(cloudList);
  const actions: SyncAction[] = [];
  for (const local of localList) {
    if (local.isFolder) continue;
    const cloud = getPath(cloudMap, local.path);
    if (!cloud || cloud.isFolder) continue;
    if (resolveConflict(local, cloud) === "local-update") {
      actions.push({ operation: "local-update", path: local.path, isFolder: false, sourceEntry: local, cloudHash: cloud.hash, cloudMtime: cloud.mtime });
    }
  }
  return actions;
}

/** Detect files on BOTH sides where cloud is newer → pull to local */
export function detectCloudUpdates(
  cloudList: FileEntry[], localList: FileEntry[], _base: Set<string> | null
): SyncAction[] {
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];
  for (const cloud of cloudList) {
    if (cloud.isFolder) continue;
    const local = getPath(localMap, cloud.path);
    if (!local || local.isFolder) continue;
    if (resolveConflict(local, cloud) === "cloud-update") {
      actions.push({ operation: "cloud-update", path: cloud.path, isFolder: false, sourceEntry: cloud });
    }
  }
  return actions;
}

/** Detect files in LOCAL only, not on cloud. If base has it → cloud deleted it, skip. */
export function detectLocalAdds(
  cloudList: FileEntry[], localList: FileEntry[], base: Set<string> | null
): SyncAction[] {
  const cloudMap = indexByPath(cloudList);
  const actions: SyncAction[] = [];
  for (const local of localList) {
    if (cloudMap.has(local.path.toLowerCase())) continue;
    // Was in base (previously synced) but gone from cloud → cloud deleted it, don't re-upload
    if (base?.has(local.path.toLowerCase())) continue;
    actions.push({ operation: "local-add", path: local.path, isFolder: local.isFolder, sourceEntry: local });
  }
  return actions;
}

/** Detect files in CLOUD only, not on local. If base has it → locally deleted, skip. */
export function detectCloudAdds(
  cloudList: FileEntry[], localList: FileEntry[], base: Set<string> | null
): SyncAction[] {
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];
  for (const cloud of cloudList) {
    if (localMap.has(cloud.path.toLowerCase())) continue;
    // Was in base (previously synced) but gone from local → locally deleted, don't re-download
    if (base?.has(cloud.path.toLowerCase())) continue;
    actions.push({ operation: "cloud-add", path: cloud.path, isFolder: cloud.isFolder, sourceEntry: cloud });
  }
  return actions;
}

/** In base + still on cloud + missing locally → user deleted locally → delete from cloud */
export function detectLocalDeletes(
  cloudList: FileEntry[], localList: FileEntry[], base: Set<string> | null
): SyncAction[] {
  if (!base?.size) return [];
  const cloudMap = indexByPath(cloudList);
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];
  for (const basePath of base) {
    if (localMap.has(basePath)) continue; // still local
    const cloud = cloudMap.get(basePath);
    if (!cloud) continue; // already gone from cloud
    actions.push({ operation: "local-delete", path: cloud.path, isFolder: cloud.isFolder, sourceEntry: cloud });
  }
  return actions;
}

/** In base + still on local + missing from cloud → cloud deleted → trash locally */
export function detectCloudDeletes(
  cloudList: FileEntry[], localList: FileEntry[], base: Set<string> | null
): SyncAction[] {
  if (!base?.size) return [];
  const cloudMap = indexByPath(cloudList);
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];
  for (const [localPath, local] of localMap) {
    if (local.isFolder) continue;
    if (cloudMap.has(localPath)) continue; // still on cloud
    if (!base.has(localPath)) continue;   // never synced → new local file
    actions.push({ operation: "cloud-delete", path: local.path, isFolder: false, sourceEntry: local });
  }
  return actions;
}

/** Map operation type → detector function (cloud, local, base) */
export const OPERATION_DETECTORS: Record<
  SyncOpType,
  (cloud: FileEntry[], local: FileEntry[], base: Set<string> | null) => SyncAction[]
> = {
  "local-update": detectLocalUpdates,
  "cloud-update": detectCloudUpdates,
  "local-add": detectLocalAdds,
  "cloud-add": detectCloudAdds,
  "local-delete": detectLocalDeletes,
  "cloud-delete": detectCloudDeletes,
};
