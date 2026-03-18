import { describe, it, expect } from "vitest";
import { compareMtime, resolveConflict } from "../src/sync/merger";
import type { FileEntry } from "../src/types";

function file(mtime: number, size = 100, hash?: string): FileEntry {
  return { path: "test.md", mtime, size, isFolder: false, hash };
}

describe("compareMtime", () => {
  it("returns local-newer when local mtime is more than 1s ahead", () => {
    expect(compareMtime(file(5000), file(3000))).toBe("local-newer");
  });

  it("returns cloud-newer when cloud mtime is more than 1s ahead", () => {
    expect(compareMtime(file(1000), file(5000))).toBe("cloud-newer");
  });

  it("returns equal when within 1s tolerance", () => {
    expect(compareMtime(file(1000), file(1500))).toBe("equal");
    expect(compareMtime(file(1500), file(1000))).toBe("equal");
  });

  it("returns equal when exactly equal", () => {
    expect(compareMtime(file(1000), file(1000))).toBe("equal");
  });
});

describe("resolveConflict", () => {
  it("returns local-update when local is newer", () => {
    expect(resolveConflict(file(5000, 200), file(1000, 200))).toBe("local-update");
  });

  it("returns cloud-update when cloud is newer", () => {
    expect(resolveConflict(file(1000, 200), file(5000, 200))).toBe("cloud-update");
  });

  it("returns null when same size and mtime within tolerance", () => {
    expect(resolveConflict(file(1000, 200), file(1500, 200))).toBeNull();
  });

  it("returns null when hashes match (regardless of mtime)", () => {
    expect(resolveConflict(file(1000, 200, "abc123"), file(9000, 200, "abc123"))).toBeNull();
  });

  it("compares by mtime when hashes differ", () => {
    expect(resolveConflict(file(5000, 200, "abc"), file(1000, 200, "def"))).toBe("local-update");
  });
});
