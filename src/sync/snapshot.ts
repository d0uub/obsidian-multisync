import type { FileEntry, Snapshot } from "../types";

/**
 * Snapshot management.
 * Snapshot = record of file states after last successful sync.
 * ONLY used for add vs delete disambiguation, not for update detection.
 */

/** Build a snapshot from a list of file entries (keyed by path) */
export function buildSnapshot(entries: FileEntry[]): Snapshot {
  const snap: Snapshot = {};
  for (const e of entries) {
    snap[e.path] = { ...e };
  }
  return snap;
}

/** Merge local + cloud lists into a unified snapshot after successful sync */
export function buildMergedSnapshot(
  localList: FileEntry[],
  cloudList: FileEntry[]
): Snapshot {
  const snap: Snapshot = {};
  // Start with cloud entries
  for (const e of cloudList) {
    snap[e.path] = { ...e };
  }
  // Overlay local entries (local mtime may be more accurate for local files)
  for (const e of localList) {
    if (snap[e.path]) {
      // Keep the entry, merge: use latest mtime
      snap[e.path] = {
        ...snap[e.path],
        mtime: Math.max(snap[e.path].mtime, e.mtime),
        size: e.size,
      };
    } else {
      snap[e.path] = { ...e };
    }
  }
  return snap;
}

/** Check if a path exists in the snapshot */
export function snapshotHas(snapshot: Snapshot, path: string): boolean {
  return path in snapshot;
}

/** Get a snapshot entry */
export function snapshotGet(
  snapshot: Snapshot,
  path: string
): FileEntry | undefined {
  return snapshot[path];
}
