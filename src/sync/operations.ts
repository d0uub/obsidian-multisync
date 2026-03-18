import type { FileEntry, Snapshot, SyncAction, SyncOpType } from "../types";
import { snapshotHas } from "./snapshot";
import { resolveConflict } from "./merger";

/**
 * Individual sync operation detectors.
 * Each function is INDEPENDENT — takes (cloudList, localList, snapshot) and returns SyncAction[].
 * The user can invoke them in any order, skip any, or reorder across rules.
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
  localList: FileEntry[],
  _snapshot: Snapshot
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
  localList: FileEntry[],
  _snapshot: Snapshot
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
 * Detect files in LOCAL only.
 * - If NOT in snapshot → new file → local-add (push to cloud)
 * - If IN snapshot → was synced before but now missing from cloud → cloud deleted it → cloud-delete (handled by detectCloudDeletes)
 * This function ONLY returns local-add actions.
 */
export function detectLocalAdds(
  cloudList: FileEntry[],
  localList: FileEntry[],
  snapshot: Snapshot
): SyncAction[] {
  const cloudMap = indexByPath(cloudList);
  const actions: SyncAction[] = [];
  for (const local of localList) {
    if (cloudMap.has(local.path)) continue; // exists on both sides, not an add
    if (snapshotHas(snapshot, local.path)) continue; // was synced before → this is a cloud-delete case
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
 * Detect files in CLOUD only.
 * - If NOT in snapshot → new cloud file → cloud-add (pull to local)
 * - If IN snapshot → was synced before but now missing locally → local deleted it → local-delete (handled by detectLocalDeletes)
 * This function ONLY returns cloud-add actions.
 */
export function detectCloudAdds(
  cloudList: FileEntry[],
  localList: FileEntry[],
  snapshot: Snapshot
): SyncAction[] {
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];
  for (const cloud of cloudList) {
    if (localMap.has(cloud.path)) continue; // exists on both sides
    if (snapshotHas(snapshot, cloud.path)) continue; // was synced before → local-delete case
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
 * Detect files that were synced (in snapshot) + exist in local but NOT in cloud.
 * → Cloud deleted it → delete from local.
 * Snapshot turns what would be "local-add" into "cloud-delete".
 */
export function detectCloudDeletes(
  cloudList: FileEntry[],
  localList: FileEntry[],
  snapshot: Snapshot
): SyncAction[] {
  const cloudMap = indexByPath(cloudList);
  const actions: SyncAction[] = [];
  for (const local of localList) {
    if (cloudMap.has(local.path)) continue; // still on cloud
    if (!snapshotHas(snapshot, local.path)) continue; // never synced → local-add, not delete
    // Was in snapshot + local, but cloud is missing → cloud deleted it
    actions.push({
      operation: "cloud-delete",
      path: local.path,
      isFolder: local.isFolder,
      sourceEntry: local,
    });
  }
  return actions;
}

/**
 * Detect files that were synced (in snapshot) + exist in cloud but NOT in local.
 * → Local deleted it → delete from cloud.
 * Snapshot turns what would be "cloud-add" into "local-delete".
 */
export function detectLocalDeletes(
  cloudList: FileEntry[],
  localList: FileEntry[],
  snapshot: Snapshot
): SyncAction[] {
  const localMap = indexByPath(localList);
  const actions: SyncAction[] = [];
  for (const cloud of cloudList) {
    if (localMap.has(cloud.path)) continue; // still local
    if (!snapshotHas(snapshot, cloud.path)) continue; // never synced → cloud-add, not delete
    // Was in snapshot + cloud, but local is missing → local deleted it
    actions.push({
      operation: "local-delete",
      path: cloud.path,
      isFolder: cloud.isFolder,
      sourceEntry: cloud,
    });
  }
  return actions;
}

/** Map of operation type to its detector function */
export const OPERATION_DETECTORS: Record<
  SyncOpType,
  (cloud: FileEntry[], local: FileEntry[], snap: Snapshot) => SyncAction[]
> = {
  "local-update": detectLocalUpdates,
  "cloud-update": detectCloudUpdates,
  "local-add": detectLocalAdds,
  "cloud-add": detectCloudAdds,
  "local-delete": detectLocalDeletes,
  "cloud-delete": detectCloudDeletes,
};
