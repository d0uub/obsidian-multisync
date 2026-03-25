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

/** Safely set SVG content via DOMParser instead of innerHTML */
export function setSvgContent(el: HTMLElement, svgString: string): void {
  el.empty();
  if (!svgString) return;
  // Ensure xmlns is present for DOMParser
  let s = svgString;
  if (s.includes("<svg") && !s.includes("xmlns")) {
    s = s.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(s, "image/svg+xml");
  const errorNode = doc.querySelector("parsererror");
  if (errorNode) return;
  const svg = doc.documentElement;
  if (svg && svg.nodeName === "svg") {
    el.appendChild((el.ownerDocument || document).importNode(svg, true));
  }
}
