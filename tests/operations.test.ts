import { describe, it, expect } from "vitest";
import {
  detectLocalUpdates,
  detectCloudUpdates,
  detectLocalAdds,
  detectCloudAdds,
  detectLocalDeletes,
  detectCloudDeletes,
} from "../src/sync/operations";
import type { FileEntry } from "../src/types";

// ─── Helpers ───

function file(path: string, mtime: number, size = 100): FileEntry {
  return { path, mtime, size, isFolder: false };
}

function folder(path: string): FileEntry {
  return { path: path + "/", mtime: 0, size: 0, isFolder: true };
}

// ─── detectLocalUpdates ───

describe("detectLocalUpdates", () => {
  it("returns actions when local file is newer than cloud", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 5000)];
    const actions = detectLocalUpdates(cloud, local);
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("local-update");
    expect(actions[0].path).toBe("a.md");
  });

  it("returns nothing when cloud is newer", () => {
    const cloud = [file("a.md", 5000)];
    const local = [file("a.md", 1000)];
    const actions = detectLocalUpdates(cloud, local);
    expect(actions).toHaveLength(0);
  });

  it("returns nothing when mtimes are within tolerance", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 1500)]; // 500ms diff < 1000ms tolerance
    const actions = detectLocalUpdates(cloud, local);
    expect(actions).toHaveLength(0);
  });

  it("ignores files only on one side", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("b.md", 5000)];
    const actions = detectLocalUpdates(cloud, local);
    expect(actions).toHaveLength(0);
  });

  it("ignores folders", () => {
    const cloud = [folder("dir")];
    const local = [folder("dir")];
    const actions = detectLocalUpdates(cloud, local);
    expect(actions).toHaveLength(0);
  });

  it("handles multiple files, only returns newer locals", () => {
    const cloud = [file("a.md", 1000), file("b.md", 9000), file("c.md", 3000)];
    const local = [file("a.md", 5000), file("b.md", 2000), file("c.md", 8000)];
    const actions = detectLocalUpdates(cloud, local);
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.path).sort()).toEqual(["a.md", "c.md"]);
  });
});

// ─── detectCloudUpdates ───

describe("detectCloudUpdates", () => {
  it("returns actions when cloud file is newer than local", () => {
    const cloud = [file("a.md", 5000)];
    const local = [file("a.md", 1000)];
    const actions = detectCloudUpdates(cloud, local);
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("cloud-update");
  });

  it("returns nothing when local is newer", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 5000)];
    const actions = detectCloudUpdates(cloud, local);
    expect(actions).toHaveLength(0);
  });
});

// ─── detectLocalAdds ───

describe("detectLocalAdds", () => {
  it("detects new local file not in cloud", () => {
    const cloud: FileEntry[] = [];
    const local = [file("new.md", 1000)];
    const actions = detectLocalAdds(cloud, local);
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("local-add");
    expect(actions[0].path).toBe("new.md");
  });

  it("excludes files in syncBase (previously synced, now cloud-deleted)", () => {
    const cloud: FileEntry[] = [];
    const local = [file("old.md", 1000)];
    const manifest = new Set(["old.md"]);
    const actions = detectLocalAdds(cloud, local, [], manifest);
    expect(actions).toHaveLength(0);
  });

  it("does NOT return file that exists on both sides", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 2000)];
    const actions = detectLocalAdds(cloud, local);
    expect(actions).toHaveLength(0);
  });

  it("detects folder adds", () => {
    const cloud: FileEntry[] = [];
    const local = [folder("newdir")];
    const actions = detectLocalAdds(cloud, local);
    expect(actions).toHaveLength(1);
    expect(actions[0].isFolder).toBe(true);
  });
});

// ─── detectCloudAdds ───

describe("detectCloudAdds", () => {
  it("detects new cloud file not in local", () => {
    const cloud = [file("cloud-new.md", 2000)];
    const local: FileEntry[] = [];
    const actions = detectCloudAdds(cloud, local);
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("cloud-add");
    expect(actions[0].path).toBe("cloud-new.md");
  });

  it("excludes files in syncBase (previously synced, now locally deleted)", () => {
    const cloud = [file("was-local.md", 2000)];
    const local: FileEntry[] = [];
    const manifest = new Set(["was-local.md"]);
    const actions = detectCloudAdds(cloud, local, [], manifest);
    expect(actions).toHaveLength(0);
  });

  it("does NOT return file that exists on both sides", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 1000)];
    const actions = detectCloudAdds(cloud, local);
    expect(actions).toHaveLength(0);
  });
});

// ─── detectLocalDeletes (manifest-based) ───

describe("detectLocalDeletes", () => {
  it("file in manifest + missing locally + on cloud → local-delete", () => {
    const cloud = [file("deleted-locally.md", 1000)];
    const local: FileEntry[] = [];
    const manifest = new Set(["deleted-locally.md"]);
    const actions = detectLocalDeletes(cloud, local, [], manifest);
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("local-delete");
    expect(actions[0].path).toBe("deleted-locally.md");
  });

  it("file in manifest + missing locally + gone from cloud → no action", () => {
    const cloud: FileEntry[] = [];
    const local: FileEntry[] = [];
    const manifest = new Set(["already-gone.md"]);
    const actions = detectLocalDeletes(cloud, local, [], manifest);
    expect(actions).toHaveLength(0);
  });

  it("file in manifest + still exists locally → no action", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 1000)];
    const manifest = new Set(["a.md"]);
    const actions = detectLocalDeletes(cloud, local, [], manifest);
    expect(actions).toHaveLength(0);
  });

  it("no manifest → no actions (first sync)", () => {
    const cloud = [file("a.md", 1000)];
    const local: FileEntry[] = [];
    const actions = detectLocalDeletes(cloud, local);
    expect(actions).toHaveLength(0);
  });
});

// ─── detectCloudDeletes (delta API driven) ───

describe("detectCloudDeletes", () => {
  it("cloud-deleted file exists locally → cloud-delete", () => {
    const cloud: FileEntry[] = [];
    const local = [file("deleted-on-cloud.md", 1000)];
    const base = new Set(["deleted-on-cloud.md"]);
    const actions = detectCloudDeletes(cloud, local, ["deleted-on-cloud.md"], base);
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("cloud-delete");
    expect(actions[0].path).toBe("deleted-on-cloud.md");
  });

  it("cloud-deleted file not local → no action", () => {
    const cloud: FileEntry[] = [];
    const local: FileEntry[] = [];
    const base = new Set(["already-gone.md"]);
    const actions = detectCloudDeletes(cloud, local, ["already-gone.md"], base);
    expect(actions).toHaveLength(0);
  });

  it("no base → no cloud deletes (first sync)", () => {
    const cloud: FileEntry[] = [];
    const local = [file("safe.md", 1000)];
    const actions = detectCloudDeletes(cloud, local, ["safe.md"]);
    expect(actions).toHaveLength(0);
  });

  it("cloud-deleted file NOT in base → no action (new local file)", () => {
    const cloud: FileEntry[] = [];
    const local = [file("new-local.md", 1000)];
    const base = new Set(["other-file.md"]);
    const actions = detectCloudDeletes(cloud, local, ["new-local.md"], base);
    expect(actions).toHaveLength(0);
  });

  it("no cloud deleted paths → no actions", () => {
    const cloud: FileEntry[] = [];
    const local = [file("safe.md", 1000)];
    const actions = detectCloudDeletes(cloud, local);
    expect(actions).toHaveLength(0);
  });
});

// ─── Manifest-based delete disambiguation ───

describe("registry-based delete disambiguation", () => {
  it("file in local only + not in manifest = local-add (new file)", () => {
    const cloud: FileEntry[] = [];
    const local = [file("new.md", 1000)];
    expect(detectLocalAdds(cloud, local)).toHaveLength(1);
    expect(detectCloudDeletes(cloud, local)).toHaveLength(0);
  });

  it("file in local only + in manifest = excluded from local-add (cloud-deleted)", () => {
    const cloud: FileEntry[] = [];
    const local = [file("old.md", 1000)];
    const manifest = new Set(["old.md"]);
    expect(detectLocalAdds(cloud, local, [], manifest)).toHaveLength(0);
  });

  it("file in cloud only + not in manifest = cloud-add (new cloud file)", () => {
    const cloud = [file("cloud-new.md", 1000)];
    const local: FileEntry[] = [];
    expect(detectCloudAdds(cloud, local)).toHaveLength(1);
    expect(detectLocalDeletes(cloud, local)).toHaveLength(0);
  });

  it("file in cloud only + in manifest = local-delete (locally deleted)", () => {
    const cloud = [file("was-here.md", 1000)];
    const local: FileEntry[] = [];
    const manifest = new Set(["was-here.md"]);
    expect(detectCloudAdds(cloud, local, [], manifest)).toHaveLength(0);
    expect(detectLocalDeletes(cloud, local, [], manifest)).toHaveLength(1);
  });
});
