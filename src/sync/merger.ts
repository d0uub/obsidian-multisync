import type { FileEntry } from "../types";

/**
 * File conflict resolution using mtime-based comparison.
 * Referenced from remotely-save's approach: newer mtime wins.
 */

/** Tolerance in ms for mtime comparison (1 second) */
const MTIME_TOLERANCE_MS = 1000;

export type MergeDecision = "local-newer" | "cloud-newer" | "equal";

/**
 * Compare two file entries by mtime to decide which is newer.
 * Uses a 1-second tolerance to account for filesystem timestamp granularity.
 */
export function compareMtime(
  local: FileEntry,
  cloud: FileEntry
): MergeDecision {
  const diff = local.mtime - cloud.mtime;
  if (diff > MTIME_TOLERANCE_MS) return "local-newer";
  if (diff < -MTIME_TOLERANCE_MS) return "cloud-newer";
  return "equal";
}

/**
 * For files that exist on both sides, decide which direction to sync.
 * Returns null if files are considered equal (no action needed).
 */
export function resolveConflict(
  local: FileEntry,
  cloud: FileEntry
): "local-update" | "cloud-update" | null {
  // If hash is available and matches, no update needed regardless of mtime
  if (local.hash && cloud.hash && local.hash === cloud.hash) return null;

  // If sizes are same and mtimes within tolerance, consider equal
  if (local.size === cloud.size) {
    const decision = compareMtime(local, cloud);
    if (decision === "equal") return null;
  }

  const decision = compareMtime(local, cloud);
  if (decision === "local-newer") return "local-update";
  if (decision === "cloud-newer") return "cloud-update";
  return null;
}
