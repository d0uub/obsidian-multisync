/**
 * MockApp — minimal Obsidian `App` mock backed by a real temp directory.
 * Used by sync-pipeline integration tests so runPipeline() can read/write
 * local files without an actual Obsidian instance.
 */
import fs from "fs";
import path from "path";

interface FileStat {
  mtime: number;
  ctime: number;
  size: number;
}

interface MockTFile {
  path: string;
  name: string;
  stat: FileStat;
}

interface MockTFolder {
  path: string;
  name: string;
}

/** Recursively walk a directory, returning relative paths to files. */
function walkFiles(root: string, prefix = ""): { relPath: string; stat: fs.Stats }[] {
  const results: { relPath: string; stat: fs.Stats }[] = [];
  if (!fs.existsSync(root)) return results;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, rel));
    } else {
      results.push({ relPath: rel, stat: fs.statSync(full) });
    }
  }
  return results;
}

/** Recursively collect subfolder relative paths. */
function walkFolders(root: string, prefix = ""): string[] {
  const results: string[] = [];
  if (!fs.existsSync(root)) return results;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    results.push(rel);
    results.push(...walkFolders(path.join(root, entry.name), rel));
  }
  return results;
}

export function createMockApp(vaultRoot: string) {
  const resolve = (p: string) => path.join(vaultRoot, p.replace(/\\/g, "/"));

  const adapter = {
    async readBinary(filePath: string): Promise<ArrayBuffer> {
      const buf = fs.readFileSync(resolve(filePath));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },

    async writeBinary(
      filePath: string,
      content: ArrayBuffer,
      opts?: { mtime?: number; ctime?: number }
    ): Promise<void> {
      const full = resolve(filePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from(content));
      if (opts?.mtime) {
        const sec = opts.mtime / 1000;
        fs.utimesSync(full, sec, sec);
      }
    },

    async exists(filePath: string): Promise<boolean> {
      return fs.existsSync(resolve(filePath));
    },

    async mkdir(filePath: string): Promise<void> {
      fs.mkdirSync(resolve(filePath), { recursive: true });
    },

    async list(dirPath: string): Promise<{ files: string[]; folders: string[] }> {
      const full = resolve(dirPath);
      if (!fs.existsSync(full)) return { files: [], folders: [] };
      const files: string[] = [];
      const folders: string[] = [];
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        const rel = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) folders.push(rel);
        else files.push(rel);
      }
      return { files, folders };
    },
  };

  const vault = {
    adapter,

    getFiles(): MockTFile[] {
      return walkFiles(vaultRoot).map(({ relPath, stat }) => ({
        path: relPath,
        name: path.basename(relPath),
        stat: { mtime: stat.mtimeMs, ctime: stat.ctimeMs, size: stat.size },
      }));
    },

    getAllFolders(): MockTFolder[] {
      return walkFolders(vaultRoot).map((rel) => ({
        path: rel,
        name: path.basename(rel),
      }));
    },

    getAbstractFileByPath(filePath: string): MockTFile | MockTFolder | null {
      const full = resolve(filePath);
      if (!fs.existsSync(full)) return null;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        return { path: filePath, name: path.basename(filePath) };
      }
      return {
        path: filePath,
        name: path.basename(filePath),
        stat: { mtime: stat.mtimeMs, ctime: stat.ctimeMs, size: stat.size },
      };
    },

    async trash(file: MockTFile | MockTFolder, _useSystem: boolean): Promise<void> {
      const full = resolve(file.path);
      if (!fs.existsSync(full)) return;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        fs.unlinkSync(full);
      }
    },

    async create(filePath: string, content: string) {
      const full = resolve(filePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
      return vault.getAbstractFileByPath(filePath);
    },

    async createFolder(folderPath: string) {
      fs.mkdirSync(resolve(folderPath), { recursive: true });
    },

    async modify(file: MockTFile, content: string) {
      fs.writeFileSync(resolve(file.path), content, "utf-8");
    },

    async delete(file: MockTFile | MockTFolder) {
      await vault.trash(file, true);
    },
  };

  return { vault };
}
