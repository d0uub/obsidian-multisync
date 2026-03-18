import { describe, it, expect } from "vitest";
import { buildSnapshot, buildMergedSnapshot, snapshotHas, snapshotGet } from "../src/sync/snapshot";
import type { FileEntry } from "../src/types";

function file(path: string, mtime: number, size = 100): FileEntry {
  return { path, mtime, size, isFolder: false };
}

describe("buildSnapshot", () => {
  it("builds a snapshot keyed by path", () => {
    const entries = [file("a.md", 1000), file("b.md", 2000)];
    const snap = buildSnapshot(entries);
    expect(Object.keys(snap)).toHaveLength(2);
    expect(snap["a.md"].mtime).toBe(1000);
    expect(snap["b.md"].mtime).toBe(2000);
  });

  it("handles empty input", () => {
    expect(Object.keys(buildSnapshot([]))).toHaveLength(0);
  });
});

describe("buildMergedSnapshot", () => {
  it("merges local and cloud lists, using max mtime", () => {
    const local = [file("a.md", 3000, 200)];
    const cloud = [file("a.md", 5000, 200)];
    const snap = buildMergedSnapshot(local, cloud);
    expect(snap["a.md"].mtime).toBe(5000); // max of 3000, 5000
    expect(snap["a.md"].size).toBe(200);  // local size
  });

  it("includes files only on one side", () => {
    const local = [file("local-only.md", 1000)];
    const cloud = [file("cloud-only.md", 2000)];
    const snap = buildMergedSnapshot(local, cloud);
    expect(Object.keys(snap)).toHaveLength(2);
    expect(snap["local-only.md"]).toBeDefined();
    expect(snap["cloud-only.md"]).toBeDefined();
  });
});

describe("snapshotHas / snapshotGet", () => {
  it("returns true/entry for existing path", () => {
    const snap = buildSnapshot([file("a.md", 1000)]);
    expect(snapshotHas(snap, "a.md")).toBe(true);
    expect(snapshotGet(snap, "a.md")?.mtime).toBe(1000);
  });

  it("returns false/undefined for missing path", () => {
    expect(snapshotHas({}, "missing.md")).toBe(false);
    expect(snapshotGet({}, "missing.md")).toBeUndefined();
  });
});
