import type { ICloudProvider, UnsyncableFile } from "./ICloudProvider";
import type { FileEntry } from "../types";
import type { ProviderMeta } from "./registry";
import { requestUrl } from "obsidian";
import { joinCloudPath } from "../utils/helpers";
import { generatePKCE } from "./registry";

/** GDrive API response types */
interface GDFile { id?: string; name?: string; mimeType?: string; size?: string; modifiedTime?: string; md5Checksum?: string; parents?: string[]; trashed?: boolean }
interface GDFileList { files?: GDFile[]; nextPageToken?: string }
interface GDChangeList { changes?: GDChange[]; nextPageToken?: string; newStartPageToken?: string }
interface GDChange { fileId?: string; removed?: boolean; file?: GDFile }
interface GDAbout { user?: { displayName?: string }; storageQuota?: { usage?: string; limit?: string } }
interface GDStartPage { startPageToken?: string }

const GDRIVE_SCOPES = "https://www.googleapis.com/auth/drive";
const CALLBACK = "multisync-cb-gdrive";
const SVG_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z"/></svg>';
const GDRIVE_CLIENT_ID = "151829948116-9v9q6qobkrd3iel5h6ob0895nkcnc637.apps.googleusercontent.com";
const GDRIVE_CLIENT_SECRET = "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";
/** GitHub Pages relay that bounces Google's redirect to obsidian:// */
const GDRIVE_REDIRECT_URI = "https://d0uub.github.io/obsidian-multisync/callback";

/** Sanitize GDrive filenames that contain characters illegal in local paths. */
function sanitizeName(name: string): string {
  // Replace characters illegal on Windows filesystems with visually similar Unicode alternatives
  return name
    .replace(/[/\\]/g, "⁄")   // fraction slash U+2044
    .replace(/:/g, "꞉")       // modifier letter colon U+A789
    .replace(/\*/g, "＊")     // fullwidth asterisk U+FF0A
    .replace(/\?/g, "？")     // fullwidth question mark U+FF1F
    .replace(/"/g, "＂")      // fullwidth quotation mark U+FF02
    .replace(/</g, "＜")      // fullwidth less-than U+FF1C
    .replace(/>/g, "＞")      // fullwidth greater-than U+FF1E
    .replace(/\|/g, "｜");    // fullwidth vertical bar U+FF5C
}

/** Reverse sanitizeName: convert Unicode alternatives back to original characters for GDrive API queries. */
function unsanitizeName(name: string): string {
  return name
    .replace(/⁄/g, "/")
    .replace(/꞉/g, ":")
    .replace(/＊/g, "*")
    .replace(/？/g, "?")
    .replace(/＂/g, '"')
    .replace(/＜/g, "<")
    .replace(/＞/g, ">")
    .replace(/｜/g, "|");
}

/** Google-native types (Docs/Sheets/etc.) cannot be downloaded as binary — skip them. */
function isGoogleNativeType(mimeType: string): boolean {
  return mimeType.startsWith("application/vnd.google-apps.") && mimeType !== "application/vnd.google-apps.folder";
}

export const GDRIVE_META: ProviderMeta = {
  type: "gdrive",
  label: "Google Drive",
  svgIcon: SVG_ICON,
  callbackProtocol: CALLBACK,
  credentialFields: [
    { key: "accessToken", label: "Access Token", secret: true },
    { key: "refreshToken", label: "Refresh Token", secret: true },
  ],
  getMissingCreds: () => [],
  autoFillCreds: (creds) => {
    if (!creds.clientId) creds.clientId = GDRIVE_CLIENT_ID;
    if (!creds.clientSecret) creds.clientSecret = GDRIVE_CLIENT_SECRET;
  },
  getAuthUrl: async (creds, _manual) => {
    const { verifier, challenge } = await generatePKCE();
    const params = new URLSearchParams({
      client_id: creds.clientId,
      response_type: "code",
      redirect_uri: GDRIVE_REDIRECT_URI,
      scope: GDRIVE_SCOPES,
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return {
      authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      verifier,
    };
  },
  exchangeCode: async (creds, code, verifier, _manual) => {
    const resp = await requestUrl({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        code,
        redirect_uri: GDRIVE_REDIRECT_URI,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });
    const data = resp.json;
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
  },
  createInstance: (creds, onTokenRefreshed) => {
    return new GDriveProvider(
      creds.accessToken || "",
      creds.refreshToken || "",
      creds.clientId || "",
      creds.clientSecret || "",
      parseInt(creds.tokenExpiry || "0", 10),
      onTokenRefreshed,
    );
  },
};

/**
 * Google Drive implementation via REST API.
 * Uses Obsidian's requestUrl for mobile compatibility.
 * GDrive uses folder IDs not paths, so we resolve paths to IDs internally.
 */
export class GDriveProvider implements ICloudProvider {
  readonly kind = "gdrive";
  unsyncableFiles: UnsyncableFile[] = [];
  private accessToken: string;
  private refreshToken: string;
  private clientId: string;
  private clientSecret: string;
  private tokenExpiry: number;
  private onTokenRefreshed?: (token: string, refresh: string, expiry: number) => void;
  /** Cache: path → folder ID */
  private folderIdCache: Map<string, string> = new Map();
  private fileIdCache: Map<string, string> = new Map();
  /** Actual root drive folder ID (resolved from "root" alias) */
  private cachedRootId: string | null = null;

  constructor(
    accessToken: string,
    refreshToken: string,
    clientId: string,
    clientSecret: string,
    tokenExpiry: number,
    onTokenRefreshed?: (token: string, refresh: string, expiry: number) => void
  ) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenExpiry = tokenExpiry;
    this.onTokenRefreshed = onTokenRefreshed;
  }

  private async ensureToken(): Promise<void> {
    if (Date.now() < this.tokenExpiry - 60000) return;
    const resp = await requestUrl({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: [
        `client_id=${this.clientId}`,
        `client_secret=${this.clientSecret}`,
        `refresh_token=${this.refreshToken}`,
        `grant_type=refresh_token`,
      ].join("&"),
    });
    const data = resp.json;
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;
    this.onTokenRefreshed?.(this.accessToken, this.refreshToken, this.tokenExpiry);
  }

  private async gdriveGet<T = Record<string, unknown>>(url: string): Promise<T> {
    await this.ensureToken();
    const resp = await requestUrl({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    return resp.json as T;
  }

  /** Get the actual root drive folder ID (resolves "root" alias). */
  private async getActualRootId(): Promise<string> {
    if (!this.cachedRootId) {
      const data = await this.gdriveGet<{id: string}>("https://www.googleapis.com/drive/v3/files/root?fields=id");
      this.cachedRootId = data.id;
    }
    return this.cachedRootId!;
  }

  /**
   * Resolve a cloud path like "/folder1/folder2" to a GDrive folder ID.
   * GDrive doesn't have real paths — must walk the tree.
   */
  private async resolveFolderId(cloudPath: string): Promise<string> {
    if (cloudPath === "/" || cloudPath === "") return "root";
    const cached = this.folderIdCache.get(cloudPath);
    if (cached) return cached;

    const parts = cloudPath.split("/").filter(Boolean);
    let parentId = "root";
    let currentPath = "";

    for (const part of parts) {
      currentPath += "/" + part;
      const cachedPart = this.folderIdCache.get(currentPath);
      if (cachedPart) {
        parentId = cachedPart;
        continue;
      }
      const query = `name='${part.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const data = await this.gdriveGet<GDFileList>(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`
      );
      if (!data.files || data.files.length === 0) {
        // Folder doesn't exist (or invisible under drive.file scope) — create it
        await this.ensureToken();
        const createResp = await requestUrl({
          url: "https://www.googleapis.com/drive/v3/files",
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: part, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
        });
        parentId = createResp.json.id;
      } else {
        parentId = data.files![0].id!;
      }
      this.folderIdCache.set(currentPath, parentId);
    }
    return parentId;
  }

  /** Marker filename for folders containing unsupported Google native files */
  static readonly UNSUPPORTED_MARKER = "Unsupported Files Detected.md";

  /** Collected native file names per folder path (populated during listFiles/syncAccountDelta) */
  private nativeFilesPerFolder = new Map<string, string[]>();
  private nativeDataCollected = false;

  /** Get the map of folder→native file names collected during the last listFiles call */
  getNativeFilesMap(): Map<string, string[]> {
    return this.nativeFilesPerFolder;
  }

  /** Returns true if native file data was collected this sync (listFiles was called) */
  hasNativeFileData(): boolean {
    return this.nativeDataCollected;
  }

  async listFiles(cloudFolder: string): Promise<FileEntry[]> {
    const rootId = await this.resolveFolderId(cloudFolder);
    // Resolve actual root drive folder ID to skip self-references
    const actualRootId = rootId === "root" ? await this.getActualRootId() : null;
    const entries: FileEntry[] = [];
    this.nativeFilesPerFolder.clear();
    this.nativeDataCollected = true;
    this.unsyncableFiles = [];
    // Clear ID caches to avoid unbounded growth across repeated syncs
    this.folderIdCache.clear();
    this.fileIdCache.clear();

    const recurse = async (folderId: string, prefix: string) => {
      let pageToken = "";
      do {
        const query = `'${folderId}' in parents and trashed=false`;
        let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)&pageSize=1000`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        const data = await this.gdriveGet<GDFileList>(url);

        for (const item of data.files || []) {
          if (item.name!.startsWith(".")) continue; // skip hidden files/folders
          // Skip root self-reference ("My Drive" folder whose ID is the root drive)
          if (actualRootId && item.id === actualRootId) continue;
          if (isGoogleNativeType(item.mimeType!)) {
            // Track native files per folder for marker generation
            const folderKey = prefix || ".";
            const list = this.nativeFilesPerFolder.get(folderKey) || [];
            list.push(item.name!);
            this.nativeFilesPerFolder.set(folderKey, list);
            const nativePath = prefix ? `${prefix}/${item.name!}` : item.name!;
            this.unsyncableFiles.push({ path: nativePath, name: item.name!, size: 0, reason: "Google native" });
            continue;
          }
          const isFolder = item.mimeType === "application/vnd.google-apps.folder";
          const basePath = prefix ? `${prefix}/${sanitizeName(item.name!)}` : sanitizeName(item.name!);

          // Cache file/folder ID for later path→ID resolution
          if (isFolder) {
            this.folderIdCache.set(joinCloudPath(cloudFolder, basePath), item.id!);
          } else {
            this.fileIdCache.set(basePath, item.id!);
          }
          entries.push({
            path: isFolder ? basePath + "/" : basePath,
            mtime: new Date(item.modifiedTime!).getTime(),
            size: parseInt(item.size || "0", 10),
            isFolder,
            hash: item.md5Checksum,
            cloudId: item.id,
          });
          if (isFolder) {
            await recurse(item.id!, basePath);
          }
        }
        pageToken = data.nextPageToken || "";
      } while (pageToken);
    };

    await recurse(rootId, "");

    // Disambiguate duplicate paths: sort by (path, mtime desc) so newest gets clean name
    entries.sort((a, b) => {
      const pathCmp = a.path.localeCompare(b.path);
      if (pathCmp !== 0) return pathCmp;
      return b.mtime - a.mtime; // newest first
    });
    const pathCount = new Map<string, number>();
    const result: FileEntry[] = [];
    for (const e of entries) {
      if (e.isFolder) { result.push(e); continue; }
      const key = e.path.toLowerCase();
      const count = pathCount.get(key) || 0;
      pathCount.set(key, count + 1);
      if (count > 0) {
        const dotIdx = e.path.lastIndexOf(".");
        let newPath: string;
        if (dotIdx > 0) {
          newPath = `${e.path.substring(0, dotIdx)} (${count})${e.path.substring(dotIdx)}`;
        } else {
          newPath = `${e.path} (${count})`;
        }
        this.fileIdCache.set(newPath, e.cloudId!);
        result.push({ ...e, path: newPath });
      } else {
        result.push(e);
      }
    }
    return result;
  }

  async readFile(cloudFolder: string, relativePath: string): Promise<ArrayBuffer> {
    const fileId = await this.resolveFileId(cloudFolder, relativePath);
    await this.ensureToken();
    try {
      const resp = await requestUrl({
        url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        method: "GET",
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      return resp.arrayBuffer;
    } catch (e) {
      // 403 = Google native type (Docs/Sheets/etc.) can’t be downloaded as binary
      if ((e as { status?: number })?.status === 403) return new ArrayBuffer(0);
      throw e;
    }
  }

  async writeFile(
    cloudFolder: string,
    relativePath: string,
    content: ArrayBuffer,
    mtime: number,
    ctime?: number
  ): Promise<void> {
    await this.ensureToken();
    const existingId = await this.resolveFileIdSafe(cloudFolder, relativePath);

    if (existingId) {
      // Update existing file
      await requestUrl({
        url: `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: content,
      });
      // Update modifiedTime
      await requestUrl({
        url: `https://www.googleapis.com/drive/v3/files/${existingId}`,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ modifiedTime: new Date(mtime).toISOString() }),
      });
    } else {
      // Create new file
      const parts = relativePath.split("/").filter(Boolean);
      const fileName = parts.pop()!;
      const parentFolder = parts.length > 0
        ? joinCloudPath(cloudFolder, parts.join("/"))
        : cloudFolder;
      const parentId = await this.resolveFolderId(parentFolder);

      // Multipart upload
      const metadata = JSON.stringify({
        name: fileName,
        parents: [parentId],
        modifiedTime: new Date(mtime).toISOString(),
        ...(ctime ? { createdTime: new Date(ctime).toISOString() } : {}),
      });
      const boundary = "multisync_boundary_" + Date.now();
      const encoder = new TextEncoder();
      const metaPart = encoder.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
      );
      const filePart = encoder.encode(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const endPart = encoder.encode(`\r\n--${boundary}--`);

      const body = new Uint8Array(metaPart.length + filePart.length + content.byteLength + endPart.length);
      body.set(metaPart, 0);
      body.set(filePart, metaPart.length);
      body.set(new Uint8Array(content), metaPart.length + filePart.length);
      body.set(endPart, metaPart.length + filePart.length + content.byteLength);

      await requestUrl({
        url: `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: body.buffer,
      });
    }
  }

  async deleteFile(cloudFolder: string, relativePath: string, cloudId?: string): Promise<void> {
    const fileId = cloudId || await this.resolveFileIdSafe(cloudFolder, relativePath);
    if (!fileId) return; // Already gone
    await this.ensureToken();
    // Move to trash instead of permanent delete
    await requestUrl({
      url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
    });
    // Remove cached ID so stat() won't find the trashed file
    this.fileIdCache.delete(relativePath);
  }

  async mkdir(cloudFolder: string, relativePath: string): Promise<void> {
    const parts = relativePath.split("/").filter(Boolean);
    let parentId = await this.resolveFolderId(cloudFolder);
    let currentPath = cloudFolder;

    for (const part of parts) {
      currentPath = joinCloudPath(currentPath, part);
      const cached = this.folderIdCache.get(currentPath);
      if (cached) {
        parentId = cached;
        continue;
      }
      // Check if folder exists
      const query = `name='${part.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const existing = await this.gdriveGet<GDFileList>(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`
      );
      if (existing.files && existing.files.length > 0) {
        parentId = existing.files[0].id!;
      } else {
        await this.ensureToken();
        const resp = await requestUrl({
          url: "https://www.googleapis.com/drive/v3/files",
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: part,
            mimeType: "application/vnd.google-apps.folder",
            parents: [parentId],
          }),
        });
        parentId = resp.json.id;
      }
      this.folderIdCache.set(currentPath, parentId);
    }
  }

  async ensureFolder(cloudFolder: string): Promise<void> {
    // GDrive auto-creates via resolveFolderId; just ensure the root folder exists
    await this.resolveFolderId(cloudFolder);
  }

  async stat(cloudFolder: string, relativePath: string): Promise<FileEntry | null> {
    try {
      const fileId = await this.resolveFileId(cloudFolder, relativePath);
      const data = await this.gdriveGet<GDFile>(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size,modifiedTime,md5Checksum,trashed`
      );
      if (data.trashed) return null;
      return {
        path: relativePath,
        mtime: new Date(data.modifiedTime!).getTime(),
        size: parseInt(data.size || "0", 10),
        isFolder: data.mimeType === "application/vnd.google-apps.folder",
        hash: data.md5Checksum,
      };
    } catch {
      return null;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.gdriveGet("https://www.googleapis.com/drive/v3/about?fields=user");
      return true;
    } catch {
      return false;
    }
  }

  async getDeletedItems(cloudFolder: string, deltaToken: string, _idToPathMap?: Record<string, string>): Promise<{ deleted: string[]; newDeltaToken: string }> {
    const deleted: string[] = [];

    if (!deltaToken) {
      // First run — get baseline token, no deletes to report
      const token = await this.getBaselineDeltaToken();
      return { deleted: [], newDeltaToken: token };
    }

    try {
      let pageToken: string | undefined = deltaToken;
      let newDeltaToken = deltaToken;

      while (pageToken) {
        const params: URLSearchParams = new URLSearchParams({
          pageToken,
          restrictToMyDrive: "true",
          includeRemoved: "true",
          fields: "changes(fileId,removed,file(id,name,mimeType,trashed,parents)),nextPageToken,newStartPageToken",
          pageSize: "1000",
        });
        const data: GDChangeList = await this.gdriveGet<GDChangeList>(`https://www.googleapis.com/drive/v3/changes?${params}`);

        for (const change of data.changes || []) {
          if (!change.removed && !change.file?.trashed) continue;
          // Resolve fileId to path via idToPathMap (cloud registry)
          const relativePath = _idToPathMap?.[change.fileId!];
          if (relativePath) deleted.push(relativePath);
        }

        pageToken = data.nextPageToken;
        if (data.newStartPageToken) newDeltaToken = data.newStartPageToken;
      }

      return { deleted, newDeltaToken };
    } catch (e) {
      console.error("GDrive getDeletedItems error:", e);
      return { deleted: [], newDeltaToken: deltaToken };
    }
  }

  /** Reverse-resolve a GDrive folder ID to its full path from root. */
  private async resolvePathFromId(fileId: string): Promise<string> {
    // Check reverse cache
    for (const [path, id] of this.folderIdCache) {
      if (id === fileId) return path;
    }
    if (fileId === "root") return "";
    const actualRoot = await this.getActualRootId();
    if (fileId === actualRoot) return "";

    // Walk up the parent chain, stopping before the root drive folder ("My Drive")
    const parts: string[] = [];
    let currentId = fileId;
    while (currentId && currentId !== "root" && currentId !== actualRoot) {
      const data = await this.gdriveGet<GDFile>(
        `https://www.googleapis.com/drive/v3/files/${currentId}?fields=name,parents`
      );
      const parentId = data.parents?.[0] || "";
      // If no parent or parent is root, this is the root drive folder — don't include it
      if (!parentId || parentId === "root" || parentId === actualRoot) break;
      parts.unshift(sanitizeName(data.name!));
      currentId = parentId;
    }
    return parts.join("/");
  }

  /** Resolve full path for a file given its name and parents array. */
  private async resolveFullPath(name: string, parents: string[] | undefined, isFolder: boolean): Promise<string> {
    const parentPath = parents?.[0] && parents[0] !== "root"
      ? await this.resolvePathFromId(parents[0])
      : "";
    const safeName = sanitizeName(name);
    const fullPath = parentPath ? `${parentPath}/${safeName}` : safeName;
    return isFolder ? fullPath + "/" : fullPath;
  }

  async syncAccountDelta(deltaToken: string): Promise<{ changes: import("./ICloudProvider").DeltaChange[]; newDeltaToken: string; isFullEnum: boolean }> {
    const isFullEnum = !deltaToken;
    const changes: import("./ICloudProvider").DeltaChange[] = [];
    const actualRootId = await this.getActualRootId();

    try {
      if (!deltaToken) {
        // Full enum: list all files the app can see via files.list
        let pageToken: string | undefined;
        do {
          const params = new URLSearchParams({
            q: "trashed=false",
            fields: "files(id,name,mimeType,size,modifiedTime,md5Checksum,parents),nextPageToken",
            pageSize: "1000",
          });
          if (pageToken) params.set("pageToken", pageToken);
          const data = await this.gdriveGet<GDFileList>(`https://www.googleapis.com/drive/v3/files?${params}`);
          for (const file of data.files || []) {
            if (file.name!.startsWith(".")) continue; // skip hidden files/folders
            if (file.id === actualRootId) continue; // skip root self-reference
            if (isGoogleNativeType(file.mimeType!)) continue;
            const isFolder = file.mimeType === "application/vnd.google-apps.folder";
            const fullPath = await this.resolveFullPath(file.name!, file.parents, isFolder);
            changes.push({
              id: file.id!,
              deleted: false,
              path: fullPath,
              entry: {
                id: file.id!,
                path: fullPath,
                mtime: new Date(file.modifiedTime!).getTime(),
                size: parseInt(file.size || "0", 10),
                isFolder,
                hash: file.md5Checksum,
              },
            });
          }
          pageToken = data.nextPageToken;
        } while (pageToken);

        const baseline = await this.getBaselineDeltaToken();
        return { changes, newDeltaToken: baseline, isFullEnum };
      }

      // Incremental: use changes.list
      let pageToken: string | undefined = deltaToken;
      let newDeltaToken = deltaToken;
      while (pageToken) {
        const params: URLSearchParams = new URLSearchParams({
          pageToken,
          restrictToMyDrive: "true",
          includeRemoved: "true",
          fields: "changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,md5Checksum,trashed,parents)),nextPageToken,newStartPageToken",
          pageSize: "1000",
        });
        const data: GDChangeList = await this.gdriveGet<GDChangeList>(`https://www.googleapis.com/drive/v3/changes?${params}`);

        for (const change of data.changes || []) {
          if (change.fileId === actualRootId) continue; // skip root self-reference
          if (change.removed || change.file?.trashed) {
            changes.push({ id: change.fileId!, deleted: true });
          } else if (change.file) {
            const f = change.file;
            if (isGoogleNativeType(f.mimeType!)) continue;
            if (f.name!.startsWith(".")) continue; // skip hidden files/folders
            const isFolder = f.mimeType === "application/vnd.google-apps.folder";
            const fullPath = await this.resolveFullPath(f.name!, f.parents, isFolder);
            changes.push({
              id: f.id!,
              deleted: false,
              path: fullPath,
              entry: {
                id: f.id!,
                path: fullPath,
                mtime: new Date(f.modifiedTime!).getTime(),
                size: parseInt(f.size || "0", 10),
                isFolder,
                hash: f.md5Checksum,
              },
            });
          }
        }

        pageToken = data.nextPageToken;
        if (data.newStartPageToken) newDeltaToken = data.newStartPageToken;
      }

      return { changes, newDeltaToken, isFullEnum };
    } catch (e) {
      console.error("GDrive syncAccountDelta error:", e);
      return { changes: [], newDeltaToken: "", isFullEnum: false };
    }
  }

  async getBaselineDeltaToken(): Promise<string> {
    const data = await this.gdriveGet<GDStartPage>("https://www.googleapis.com/drive/v3/changes/startPageToken");
    return data.startPageToken || "";
  }

  async getDisplayName(): Promise<string> {
    try {
      const about = await this.gdriveGet<GDAbout>(
        "https://www.googleapis.com/drive/v3/about?fields=user(displayName)"
      );
      return about.user?.displayName || "Google Drive";
    } catch {
      return "Google Drive";
    }
  }

  async getQuota(): Promise<{ used: number; total: number } | null> {
    try {
      const about = await this.gdriveGet<GDAbout>(
        "https://www.googleapis.com/drive/v3/about?fields=storageQuota"
      );
      const q = about.storageQuota;
      if (q && q.limit) return { used: parseInt(q.usage || "0", 10), total: parseInt(q.limit, 10) };
      return null;
    } catch {
      return null;
    }
  }

  /** Resolve a file path to its GDrive file ID. Throws if not found. */
  private async resolveFileId(cloudFolder: string, relativePath: string): Promise<string> {
    const id = await this.resolveFileIdSafe(cloudFolder, relativePath);
    if (!id) throw new Error(`GDrive file not found: ${relativePath}`);
    return id;
  }

  /** Resolve a file path to its GDrive file ID. Returns null if not found. */
  private async resolveFileIdSafe(cloudFolder: string, relativePath: string): Promise<string | null> {
    // Check cached ID from listFiles first (handles sanitized names, special chars)
    // Case-insensitive lookup: syncBase paths are lowercase, but cache keys are original case
    const cached = this.fileIdCache.get(relativePath);
    if (cached) return cached;
    const relLower = relativePath.toLowerCase();
    for (const [k, v] of this.fileIdCache) {
      if (k.toLowerCase() === relLower) return v;
    }

    const parts = relativePath.split("/").filter(Boolean);
    const fileName = parts.pop()!;
    const parentFolder = parts.length > 0
      ? joinCloudPath(cloudFolder, parts.join("/"))
      : cloudFolder;

    let parentId: string;
    try {
      parentId = await this.resolveFolderId(parentFolder);
    } catch {
      return null;
    }

    // Try original (sanitized) name first, then reverse-sanitize for GDrive original name
    const namesToTry = [fileName];
    const unsanitized = unsanitizeName(fileName);
    if (unsanitized !== fileName) namesToTry.push(unsanitized);

    for (const name of namesToTry) {
      const query = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
      const data = await this.gdriveGet<GDFileList>(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`
      );
      if (data.files && data.files.length > 0) return data.files[0].id!;
    }
    return null;
  }
}
