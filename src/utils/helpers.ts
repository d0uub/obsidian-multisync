/**
 * Path normalization utilities for cross-platform cloud sync.
 */

/** Normalize path: remove leading/trailing slashes, collapse double slashes */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/+/g, "/");
}

/** Join cloud folder + relative path into a clean cloud path */
export function joinCloudPath(cloudFolder: string, relativePath: string): string {
  const folder = cloudFolder.replace(/\/+$/, "");
  const rel = relativePath.replace(/^\/+/, "");
  if (!folder || folder === "/") return "/" + rel;
  const joined = folder + "/" + rel;
  return joined.startsWith("/") ? joined : "/" + joined;
}

/** Get the parent folder of a path */
export function parentPath(p: string): string {
  const parts = normalizePath(p).split("/");
  parts.pop();
  return parts.join("/");
}

/** Get file name from path */
export function fileName(p: string): string {
  const parts = normalizePath(p).split("/");
  return parts[parts.length - 1] || "";
}
