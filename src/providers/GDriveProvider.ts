import type { ICloudProvider } from "./ICloudProvider";
import type { FileEntry } from "../types";
import { requestUrl } from "obsidian";
import { normalizePath, joinCloudPath } from "../utils/helpers";

/**
 * Google Drive implementation via REST API.
 * Uses Obsidian's requestUrl for mobile compatibility.
 * GDrive uses folder IDs not paths, so we resolve paths to IDs internally.
 */
export class GDriveProvider implements ICloudProvider {
  readonly kind = "gdrive";
  private accessToken: string;
  private refreshToken: string;
  private clientId: string;
  private clientSecret: string;
  private tokenExpiry: number;
  private onTokenRefreshed?: (token: string, refresh: string, expiry: number) => void;
  /** Cache: path → folder ID */
  private folderIdCache: Map<string, string> = new Map();

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

  private async gdriveGet(url: string): Promise<any> {
    await this.ensureToken();
    const resp = await requestUrl({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    return resp.json;
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
      const data = await this.gdriveGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`
      );
      if (!data.files || data.files.length === 0) {
        throw new Error(`GDrive folder not found: ${currentPath}`);
      }
      parentId = data.files[0].id;
      this.folderIdCache.set(currentPath, parentId);
    }
    return parentId;
  }

  async listFiles(cloudFolder: string): Promise<FileEntry[]> {
    const rootId = await this.resolveFolderId(cloudFolder);
    const entries: FileEntry[] = [];

    const recurse = async (folderId: string, prefix: string) => {
      let pageToken = "";
      do {
        const query = `'${folderId}' in parents and trashed=false`;
        let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)&pageSize=1000`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        const data = await this.gdriveGet(url);

        for (const item of data.files || []) {
          const isFolder = item.mimeType === "application/vnd.google-apps.folder";
          const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
          entries.push({
            path: isFolder ? itemPath + "/" : itemPath,
            mtime: new Date(item.modifiedTime).getTime(),
            size: parseInt(item.size || "0", 10),
            isFolder,
            hash: item.md5Checksum,
          });
          if (isFolder) {
            await recurse(item.id, itemPath);
          }
        }
        pageToken = data.nextPageToken || "";
      } while (pageToken);
    };

    await recurse(rootId, "");
    return entries;
  }

  async readFile(cloudFolder: string, relativePath: string): Promise<ArrayBuffer> {
    const fileId = await this.resolveFileId(cloudFolder, relativePath);
    await this.ensureToken();
    const resp = await requestUrl({
      url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    return resp.arrayBuffer;
  }

  async writeFile(
    cloudFolder: string,
    relativePath: string,
    content: ArrayBuffer,
    mtime: number
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

  async deleteFile(cloudFolder: string, relativePath: string): Promise<void> {
    const fileId = await this.resolveFileId(cloudFolder, relativePath);
    await this.ensureToken();
    await requestUrl({
      url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
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
      const existing = await this.gdriveGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`
      );
      if (existing.files && existing.files.length > 0) {
        parentId = existing.files[0].id;
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

  async stat(cloudFolder: string, relativePath: string): Promise<FileEntry | null> {
    try {
      const fileId = await this.resolveFileId(cloudFolder, relativePath);
      const data = await this.gdriveGet(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size,modifiedTime,md5Checksum`
      );
      return {
        path: relativePath,
        mtime: new Date(data.modifiedTime).getTime(),
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

  async getDisplayName(): Promise<string> {
    try {
      const about = await this.gdriveGet(
        "https://www.googleapis.com/drive/v3/about?fields=user(displayName)"
      );
      return about.user?.displayName || "Google Drive";
    } catch {
      return "Google Drive";
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

    const query = `name='${fileName.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
    const data = await this.gdriveGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`
    );
    if (!data.files || data.files.length === 0) return null;
    return data.files[0].id;
  }
}
