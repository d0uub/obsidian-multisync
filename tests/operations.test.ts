import { describe, it, expect } from "vitest";
import {
  detectLocalUpdates,
  detectCloudUpdates,
  detectLocalAdds,
  detectCloudAdds,
  detectLocalDeletes,
  detectCloudDeletes,
} from "../src/sync/operations";
import type { FileEntry, Snapshot } from "../src/types";

// ─── Helpers ───

function file(path: string, mtime: number, size = 100): FileEntry {
  return { path, mtime, size, isFolder: false };
}

function folder(path: string): FileEntry {
  return { path: path + "/", mtime: 0, size: 0, isFolder: true };
}

function snap(entries: FileEntry[]): Snapshot {
  const s: Snapshot = {};
  for (const e of entries) s[e.path] = { ...e };
  return s;
}

// ─── detectLocalUpdates ───

describe("detectLocalUpdates", () => {
  it("returns actions when local file is newer than cloud", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 5000)];
    const actions = detectLocalUpdates(cloud, local, {});
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("local-update");
    expect(actions[0].path).toBe("a.md");
  });

  it("returns nothing when cloud is newer", () => {
    const cloud = [file("a.md", 5000)];
    const local = [file("a.md", 1000)];
    const actions = detectLocalUpdates(cloud, local, {});
    expect(actions).toHaveLength(0);
  });

  it("returns nothing when mtimes are within tolerance", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 1500)]; // 500ms diff < 1000ms tolerance
    const actions = detectLocalUpdates(cloud, local, {});
    expect(actions).toHaveLength(0);
  });

  it("ignores files only on one side", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("b.md", 5000)];
    const actions = detectLocalUpdates(cloud, local, {});
    expect(actions).toHaveLength(0);
  });

  it("ignores folders", () => {
    const cloud = [folder("dir")];
    const local = [folder("dir")];
    const actions = detectLocalUpdates(cloud, local, {});
    expect(actions).toHaveLength(0);
  });

  it("handles multiple files, only returns newer locals", () => {
    const cloud = [file("a.md", 1000), file("b.md", 9000), file("c.md", 3000)];
    const local = [file("a.md", 5000), file("b.md", 2000), file("c.md", 8000)];
    const actions = detectLocalUpdates(cloud, local, {});
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.path).sort()).toEqual(["a.md", "c.md"]);
  });
});

// ─── detectCloudUpdates ───

describe("detectCloudUpdates", () => {
  it("returns actions when cloud file is newer than local", () => {
    const cloud = [file("a.md", 5000)];
    const local = [file("a.md", 1000)];
    const actions = detectCloudUpdates(cloud, local, {});
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("cloud-update");
  });

  it("returns nothing when local is newer", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 5000)];
    const actions = detectCloudUpdates(cloud, local, {});
    expect(actions).toHaveLength(0);
  });
});

// ─── detectLocalAdds ───

describe("detectLocalAdds", () => {
  it("detects new local file not in cloud or snapshot", () => {
    const cloud: FileEntry[] = [];
    const local = [file("new.md", 1000)];
    const actions = detectLocalAdds(cloud, local, {});
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("local-add");
    expect(actions[0].path).toBe("new.md");
  });

  it("does NOT return file that exists in snapshot (cloud-delete case)", () => {
    const cloud: FileEntry[] = [];
    const local = [file("old.md", 1000)];
    const snapshot = snap([file("old.md", 500)]);
    const actions = detectLocalAdds(cloud, local, snapshot);
    expect(actions).toHaveLength(0); // This is a cloud-delete, not local-add
  });

  it("does NOT return file that exists on both sides", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 2000)];
    const actions = detectLocalAdds(cloud, local, {});
    expect(actions).toHaveLength(0); // exists on both sides = update, not add
  });

  it("detects folder adds", () => {
    const cloud: FileEntry[] = [];
    const local = [folder("newdir")];
    const actions = detectLocalAdds(cloud, local, {});
    expect(actions).toHaveLength(1);
    expect(actions[0].isFolder).toBe(true);
  });
});

// ─── detectCloudAdds ───

describe("detectCloudAdds", () => {
  it("detects new cloud file not in local or snapshot", () => {
    const cloud = [file("cloud-new.md", 2000)];
    const local: FileEntry[] = [];
    const actions = detectCloudAdds(cloud, local, {});
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("cloud-add");
    expect(actions[0].path).toBe("cloud-new.md");
  });

  it("does NOT return file that exists in snapshot (local-delete case)", () => {
    const cloud = [file("was-local.md", 2000)];
    const local: FileEntry[] = [];
    const snapshot = snap([file("was-local.md", 1000)]);
    const actions = detectCloudAdds(cloud, local, snapshot);
    expect(actions).toHaveLength(0); // This is a local-delete, not cloud-add
  });

  it("does NOT return file that exists on both sides", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 1000)];
    const actions = detectCloudAdds(cloud, local, {});
    expect(actions).toHaveLength(0);
  });
});

// ─── detectLocalDeletes ───

describe("detectLocalDeletes", () => {
  it("detects file in cloud+snapshot but not local → local deleted → delete from cloud", () => {
    const cloud = [file("deleted-locally.md", 1000)];
    const local: FileEntry[] = [];
    const snapshot = snap([file("deleted-locally.md", 1000)]);
    const actions = detectLocalDeletes(cloud, local, snapshot);
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("local-delete");
    expect(actions[0].path).toBe("deleted-locally.md");
  });

  it("does NOT flag file in cloud only (no snapshot) → that is cloud-add", () => {
    const cloud = [file("brand-new-cloud.md", 1000)];
    const local: FileEntry[] = [];
    const actions = detectLocalDeletes(cloud, local, {});
    expect(actions).toHaveLength(0);
  });

  it("does NOT flag file that exists on both sides", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 1000)];
    const snapshot = snap([file("a.md", 1000)]);
    const actions = detectLocalDeletes(cloud, local, snapshot);
    expect(actions).toHaveLength(0);
  });
});

// ─── detectCloudDeletes ───

describe("detectCloudDeletes", () => {
  it("detects file in local+snapshot but not cloud → cloud deleted → delete from local", () => {
    const cloud: FileEntry[] = [];
    const local = [file("deleted-on-cloud.md", 1000)];
    const snapshot = snap([file("deleted-on-cloud.md", 1000)]);
    const actions = detectCloudDeletes(cloud, local, snapshot);
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe("cloud-delete");
    expect(actions[0].path).toBe("deleted-on-cloud.md");
  });

  it("does NOT flag file in local only (no snapshot) → that is local-add", () => {
    const cloud: FileEntry[] = [];
    const local = [file("brand-new-local.md", 1000)];
    const actions = detectCloudDeletes(cloud, local, {});
    expect(actions).toHaveLength(0);
  });

  it("does NOT flag file that exists on both sides", () => {
    const cloud = [file("a.md", 1000)];
    const local = [file("a.md", 1000)];
    const snapshot = snap([file("a.md", 1000)]);
    const actions = detectCloudDeletes(cloud, local, snapshot);
    expect(actions).toHaveLength(0);
  });
});

// ─── Snapshot disambiguation (the key design) ───

describe("snapshot disambiguation: add vs delete", () => {
  it("file in local only + no snapshot = local-add (new file)", () => {
    const cloud: FileEntry[] = [];
    const local = [file("new.md", 1000)];
    expect(detectLocalAdds(cloud, local, {})).toHaveLength(1);
    expect(detectCloudDeletes(cloud, local, {})).toHaveLength(0);
  });

  it("file in local only + in snapshot = cloud-delete (cloud removed it)", () => {
    const cloud: FileEntry[] = [];
    const local = [file("old.md", 1000)];
    const snapshot = snap([file("old.md", 500)]);
    expect(detectLocalAdds(cloud, local, snapshot)).toHaveLength(0);
    expect(detectCloudDeletes(cloud, local, snapshot)).toHaveLength(1);
  });

  it("file in cloud only + no snapshot = cloud-add (new cloud file)", () => {
    const cloud = [file("cloud-new.md", 1000)];
    const local: FileEntry[] = [];
    expect(detectCloudAdds(cloud, local, {})).toHaveLength(1);
    expect(detectLocalDeletes(cloud, local, {})).toHaveLength(0);
  });

  it("file in cloud only + in snapshot = local-delete (local removed it)", () => {
    const cloud = [file("was-here.md", 1000)];
    const local: FileEntry[] = [];
    const snapshot = snap([file("was-here.md", 1000)]);
    expect(detectCloudAdds(cloud, local, snapshot)).toHaveLength(0);
    expect(detectLocalDeletes(cloud, local, snapshot)).toHaveLength(1);
  });
});
