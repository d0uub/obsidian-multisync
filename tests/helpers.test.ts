import { describe, it, expect } from "vitest";
import { normalizePath, joinCloudPath, parentPath, fileName } from "../src/utils/helpers";

describe("normalizePath", () => {
  it("removes leading and trailing slashes", () => {
    expect(normalizePath("/foo/bar/")).toBe("foo/bar");
  });
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("foo\\bar\\baz")).toBe("foo/bar/baz");
  });
  it("collapses double slashes", () => {
    expect(normalizePath("foo//bar///baz")).toBe("foo/bar/baz");
  });
  it("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });
});

describe("joinCloudPath", () => {
  it("joins folder and relative path", () => {
    expect(joinCloudPath("/officefolder", "notes/todo.md")).toBe("/officefolder/notes/todo.md");
  });
  it("handles root folder", () => {
    expect(joinCloudPath("/", "file.md")).toBe("/file.md");
  });
  it("handles empty cloud folder", () => {
    expect(joinCloudPath("", "file.md")).toBe("/file.md");
  });
  it("strips trailing slash from folder", () => {
    expect(joinCloudPath("/folder/", "file.md")).toBe("/folder/file.md");
  });
});

describe("parentPath", () => {
  it("returns parent of a file path", () => {
    expect(parentPath("foo/bar/baz.md")).toBe("foo/bar");
  });
  it("returns empty for top-level file", () => {
    expect(parentPath("file.md")).toBe("");
  });
});

describe("fileName", () => {
  it("returns the file name from path", () => {
    expect(fileName("foo/bar/baz.md")).toBe("baz.md");
  });
  it("returns the name for simple path", () => {
    expect(fileName("file.md")).toBe("file.md");
  });
});
