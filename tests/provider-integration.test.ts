import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ICloudProvider } from "../src/providers/ICloudProvider";
import type { FileEntry, SyncRule, CloudAccount, MultiSyncSettings, Snapshot } from "../src/types";
import {
  detectLocalUpdates,
  detectCloudUpdates,
  detectLocalAdds,
  detectCloudAdds,
  detectLocalDeletes,
  detectCloudDeletes,
  OPERATION_DETECTORS,
} from "../src/sync/operations";

/**
 * Mock cloud provider that simulates a remote file system in memory.
 * Allows testing the full operation → provider execution path.
 */
class MockCloudProvider implements ICloudProvider {
  readonly kind = "mock";
  files: Map<string, { content: ArrayBuffer; mtime: number; size: number }> = new Map();
  folders: Set<string> = new Set();
  callLog: string[] = [];

  async listFiles(_cloudFolder: string): Promise<FileEntry[]> {
    this.callLog.push("listFiles");
    const entries: FileEntry[] = [];
    for (const [path, meta] of this.files) {
      entries.push({ path, mtime: meta.mtime, size: meta.size, isFolder: false });
    }
    for (const path of this.folders) {
      entries.push({ path: path + "/", mtime: 0, size: 0, isFolder: true });
    }
    return entries;
  }

  async readFile(_cloudFolder: string, relativePath: string): Promise<ArrayBuffer> {
    this.callLog.push(`readFile:${relativePath}`);
    const f = this.files.get(relativePath);
    if (!f) throw new Error(`File not found: ${relativePath}`);
    return f.content;
  }

  async writeFile(
    _cloudFolder: string,
    relativePath: string,
    content: ArrayBuffer,
    mtime: number
  ): Promise<void> {
    this.callLog.push(`writeFile:${relativePath}`);
    this.files.set(relativePath, { content, mtime, size: content.byteLength });
  }

  async deleteFile(_cloudFolder: string, relativePath: string): Promise<void> {
    this.callLog.push(`deleteFile:${relativePath}`);
    this.files.delete(relativePath);
    this.folders.delete(relativePath);
  }

  async mkdir(_cloudFolder: string, relativePath: string): Promise<void> {
    this.callLog.push(`mkdir:${relativePath}`);
    this.folders.add(relativePath);
  }

  async stat(_cloudFolder: string, relativePath: string): Promise<FileEntry | null> {
    this.callLog.push(`stat:${relativePath}`);
    const f = this.files.get(relativePath);
    if (f) return { path: relativePath, mtime: f.mtime, size: f.size, isFolder: false };
    if (this.folders.has(relativePath)) {
      return { path: relativePath + "/", mtime: 0, size: 0, isFolder: true };
    }
    return null;
  }

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getDisplayName(): Promise<string> {
    return "MockProvider";
  }

  // ─── Helpers for test setup ───

  addFile(path: string, content: string, mtime: number) {
    const encoder = new TextEncoder();
    const buf = encoder.encode(content).buffer as ArrayBuffer;
    this.files.set(path, { content: buf, mtime, size: buf.byteLength });
  }

  addFolder(path: string) {
    this.folders.add(path);
  }

  reset() {
    this.files.clear();
    this.folders.clear();
    this.callLog = [];
  }
}

// ─── Helpers ───

function file(path: string, mtime: number, size = 100): FileEntry {
  return { path, mtime, size, isFolder: false };
}

function snap(entries: FileEntry[]): Snapshot {
  const s: Snapshot = {};
  for (const e of entries) s[e.path] = { ...e };
  return s;
}

// ═══════════════════════════════════════════════
// Provider basic operations
// ═══════════════════════════════════════════════

describe("MockCloudProvider", () => {
  let provider: MockCloudProvider;

  beforeEach(() => {
    provider = new MockCloudProvider();
  });

  it("lists files and folders", async () => {
    provider.addFile("notes/a.md", "hello", 1000);
    provider.addFolder("notes");
    const list = await provider.listFiles("/");
    expect(list).toHaveLength(2);
    expect(list.find(e => e.path === "notes/a.md")).toBeDefined();
    expect(list.find(e => e.path === "notes/")).toBeDefined();
  });

  it("reads a file", async () => {
    provider.addFile("test.md", "content here", 2000);
    const buf = await provider.readFile("/", "test.md");
    const text = new TextDecoder().decode(buf);
    expect(text).toBe("content here");
  });

  it("writes a file", async () => {
    const content = new TextEncoder().encode("new content").buffer as ArrayBuffer;
    await provider.writeFile("/", "new.md", content, 3000);
    expect(provider.files.has("new.md")).toBe(true);
    expect(provider.files.get("new.md")!.mtime).toBe(3000);
  });

  it("deletes a file", async () => {
    provider.addFile("del.md", "bye", 1000);
    await provider.deleteFile("/", "del.md");
    expect(provider.files.has("del.md")).toBe(false);
  });

  it("creates a folder", async () => {
    await provider.mkdir("/", "newfolder");
    expect(provider.folders.has("newfolder")).toBe(true);
  });

  it("stats a file", async () => {
    provider.addFile("x.md", "data", 5000);
    const s = await provider.stat("/", "x.md");
    expect(s).not.toBeNull();
    expect(s!.mtime).toBe(5000);
  });

  it("returns null for missing stat", async () => {
    const s = await provider.stat("/", "missing.md");
    expect(s).toBeNull();
  });

  it("logs all operations", async () => {
    provider.addFile("a.md", "x", 1000);
    await provider.listFiles("/");
    await provider.readFile("/", "a.md");
    await provider.stat("/", "a.md");
    expect(provider.callLog).toEqual(["listFiles", "readFile:a.md", "stat:a.md"]);
  });
});

// ═══════════════════════════════════════════════
// Operations → Provider integration
// ═══════════════════════════════════════════════

describe("operations + provider integration", () => {
  let provider: MockCloudProvider;

  beforeEach(() => {
    provider = new MockCloudProvider();
  });

  it("detectLocalUpdates finds files to push when local is newer", () => {
    // Cloud has old version, local has new version
    const cloudList = [file("doc.md", 1000, 50)];
    const localList = [file("doc.md", 5000, 60)];
    const actions = detectLocalUpdates(cloudList, localList, {});
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("local-update");
    expect(actions[0].sourceEntry?.mtime).toBe(5000);
  });

  it("detectCloudUpdates finds files to pull when cloud is newer", () => {
    const cloudList = [file("doc.md", 5000, 60)];
    const localList = [file("doc.md", 1000, 50)];
    const actions = detectCloudUpdates(cloudList, localList, {});
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("cloud-update");
  });

  it("full scenario: new files on both sides + deletions", () => {
    // Scenario:
    // - cloud has: a.md (old), c.md (new from cloud)
    // - local has: a.md (newer), b.md (new local file)
    // - snapshot had: a.md, d.md
    // Expected:
    //   a.md → local-update (local newer)
    //   b.md → local-add (new, not in snapshot)
    //   c.md → cloud-add (new, not in snapshot)
    //   d.md → was in snapshot, missing from both → no action (already gone)

    const cloudList = [file("a.md", 1000), file("c.md", 3000)];
    const localList = [file("a.md", 5000), file("b.md", 2000)];
    const snapshot = snap([file("a.md", 500), file("d.md", 100)]);

    const localUpdates = detectLocalUpdates(cloudList, localList, snapshot);
    expect(localUpdates).toHaveLength(1);
    expect(localUpdates[0].path).toBe("a.md");

    const cloudUpdates = detectCloudUpdates(cloudList, localList, snapshot);
    expect(cloudUpdates).toHaveLength(0);

    const localAdds = detectLocalAdds(cloudList, localList, snapshot);
    expect(localAdds).toHaveLength(1);
    expect(localAdds[0].path).toBe("b.md");

    const cloudAdds = detectCloudAdds(cloudList, localList, snapshot);
    expect(cloudAdds).toHaveLength(1);
    expect(cloudAdds[0].path).toBe("c.md");

    const localDeletes = detectLocalDeletes(cloudList, localList, snapshot);
    expect(localDeletes).toHaveLength(0); // d.md is gone from both sides

    const cloudDeletes = detectCloudDeletes(cloudList, localList, snapshot);
    expect(cloudDeletes).toHaveLength(0);
  });

  it("deletion scenario: file deleted locally, still on cloud + snapshot", () => {
    const cloudList = [file("deleted-locally.md", 1000)];
    const localList: FileEntry[] = [];
    const snapshot = snap([file("deleted-locally.md", 1000)]);

    const localDeletes = detectLocalDeletes(cloudList, localList, snapshot);
    expect(localDeletes).toHaveLength(1);
    expect(localDeletes[0].operation).toBe("local-delete");

    // Should NOT appear as cloud-add
    const cloudAdds = detectCloudAdds(cloudList, localList, snapshot);
    expect(cloudAdds).toHaveLength(0);
  });

  it("deletion scenario: file deleted on cloud, still local + snapshot", () => {
    const cloudList: FileEntry[] = [];
    const localList = [file("deleted-on-cloud.md", 1000)];
    const snapshot = snap([file("deleted-on-cloud.md", 1000)]);

    const cloudDeletes = detectCloudDeletes(cloudList, localList, snapshot);
    expect(cloudDeletes).toHaveLength(1);
    expect(cloudDeletes[0].operation).toBe("cloud-delete");

    // Should NOT appear as local-add
    const localAdds = detectLocalAdds(cloudList, localList, snapshot);
    expect(localAdds).toHaveLength(0);
  });

  it("OPERATION_DETECTORS map has all 6 operations", () => {
    const ops = Object.keys(OPERATION_DETECTORS);
    expect(ops).toContain("local-update");
    expect(ops).toContain("cloud-update");
    expect(ops).toContain("local-add");
    expect(ops).toContain("cloud-add");
    expect(ops).toContain("local-delete");
    expect(ops).toContain("cloud-delete");
    expect(ops).toHaveLength(6);
  });

  it("each OPERATION_DETECTORS entry is callable and returns SyncAction[]", () => {
    const cloudList = [file("x.md", 1000)];
    const localList = [file("x.md", 5000)];
    for (const [op, detector] of Object.entries(OPERATION_DETECTORS)) {
      const result = detector(cloudList, localList, {});
      expect(Array.isArray(result)).toBe(true);
      for (const action of result) {
        expect(action).toHaveProperty("operation");
        expect(action).toHaveProperty("path");
        expect(action).toHaveProperty("isFolder");
      }
    }
  });
});

// ═══════════════════════════════════════════════
// 2D matrix: multiple rules + operations
// ═══════════════════════════════════════════════

describe("2D matrix: rule × operation independence", () => {
  it("same operation on different rules produces independent results", () => {
    // Rule 1: cloud has old file, local has new → local-update
    const cloud1 = [file("a.md", 1000)];
    const local1 = [file("a.md", 5000)];

    // Rule 2: cloud has new file, local has old → cloud-update
    const cloud2 = [file("b.md", 5000)];
    const local2 = [file("b.md", 1000)];

    const r1Updates = detectLocalUpdates(cloud1, local1, {});
    const r2Updates = detectLocalUpdates(cloud2, local2, {});

    expect(r1Updates).toHaveLength(1);
    expect(r1Updates[0].path).toBe("a.md");
    expect(r2Updates).toHaveLength(0); // cloud is newer on rule 2
  });

  it("operations are composable: run subset of operations", () => {
    const cloud = [file("existing.md", 1000), file("cloud-new.md", 3000)];
    const local = [file("existing.md", 5000), file("local-new.md", 2000)];
    const snapshot: Snapshot = {};

    // Only run adds (skip updates and deletes)
    const localAdds = detectLocalAdds(cloud, local, snapshot);
    const cloudAdds = detectCloudAdds(cloud, local, snapshot);

    expect(localAdds).toHaveLength(1);
    expect(localAdds[0].path).toBe("local-new.md");
    expect(cloudAdds).toHaveLength(1);
    expect(cloudAdds[0].path).toBe("cloud-new.md");

    // Updates would also be detected if run
    const localUpdates = detectLocalUpdates(cloud, local, snapshot);
    expect(localUpdates).toHaveLength(1);
    expect(localUpdates[0].path).toBe("existing.md");
  });

  it("empty lists produce no actions for any operation", () => {
    for (const detector of Object.values(OPERATION_DETECTORS)) {
      expect(detector([], [], {})).toHaveLength(0);
    }
  });
});
