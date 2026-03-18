import type { ICloudProvider } from "./ICloudProvider";
import type { FileEntry } from "../types";
import { requestUrl } from "obsidian";
import { normalizePath, joinCloudPath } from "../utils/helpers";

/**
 * OneDrive implementation via Microsoft Graph REST API.
 * Uses Obsidian's requestUrl for mobile compatibility.
 */
export class OneDriveProvider implements ICloudProvider {
  readonly kind = "onedrive";
  private accessToken: string;
  private refreshToken: string;
  private clientId: string;
  private tokenExpiry: number;
  private onTokenRefreshed?: (token: string, refresh: string, expiry: number) => void;

  constructor(
    accessToken: string,
    refreshToken: string,
    clientId: string,
    tokenExpiry: number,
    onTokenRefreshed?: (token: string, refresh: string, expiry: number) => void
  ) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.clientId = clientId;
    this.tokenExpiry = tokenExpiry;
    this.onTokenRefreshed = onTokenRefreshed;
  }

  private async ensureToken(): Promise<void> {
    if (Date.now() < this.tokenExpiry - 60000) return;
    const resp = await requestUrl({
      url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: [
        `client_id=${this.clientId}`,
        `refresh_token=${this.refreshToken}`,
        `grant_type=refresh_token`,
        `scope=Files.ReadWrite.All offline_access`,
      ].join("&"),
    });
    const data = resp.json;
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token || this.refreshToken;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;
    this.onTokenRefreshed?.(this.accessToken, this.refreshToken, this.tokenExpiry);
  }

  private async graphGet(path: string): Promise<any> {
    await this.ensureToken();
    const resp = await requestUrl({
      url: `https://graph.microsoft.com/v1.0${path}`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    return resp.json;
  }

  private async graphPut(path: string, content: ArrayBuffer): Promise<any> {
    await this.ensureToken();
    const resp = await requestUrl({
      url: `https://graph.microsoft.com/v1.0${path}`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: content,
    });
    return resp.json;
  }

  private async graphDelete(path: string): Promise<void> {
    await this.ensureToken();
    await requestUrl({
      url: `https://graph.microsoft.com/v1.0${path}`,
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
  }

  private async graphPost(path: string, body: Record<string, unknown>): Promise<any> {
    await this.ensureToken();
    const resp = await requestUrl({
      url: `https://graph.microsoft.com/v1.0${path}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return resp.json;
  }

  private encodePath(cloudFolder: string, relativePath?: string): string {
    const full = relativePath
      ? joinCloudPath(cloudFolder, relativePath)
      : cloudFolder;
    if (full === "/" || full === "") return "/me/drive/root";
    return `/me/drive/root:${full}`;
  }

  async listFiles(cloudFolder: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    const driveItemPath =
      cloudFolder === "/" || cloudFolder === ""
        ? "/me/drive/root"
        : `/me/drive/root:${cloudFolder}:`;

    // Recursive listing via /children
    const recurse = async (apiPath: string, prefix: string) => {
      let url = `${apiPath}/children?$select=name,size,lastModifiedDateTime,folder,file&$top=200`;
      while (url) {
        let data: any;
        try {
          data = await this.graphGetRaw(url);
        } catch (e: any) {
          // 404 = folder doesn't exist on cloud yet → return empty
          if (e?.status === 404 || e?.message?.includes("404")) return;
          throw e;
        }
        for (const item of data.value || []) {
          const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
          const isFolder = !!item.folder;
          entries.push({
            path: isFolder ? itemPath + "/" : itemPath,
            mtime: new Date(item.lastModifiedDateTime).getTime(),
            size: item.size || 0,
            isFolder,
            hash: item.file?.hashes?.quickXorHash,
          });
          if (isFolder) {
            await recurse(`/me/drive/items/${item.id}`, itemPath);
          }
        }
        url = data["@odata.nextLink"] || "";
        if (url) {
          // nextLink is absolute URL, strip the graph prefix
          url = url.replace("https://graph.microsoft.com/v1.0", "");
        }
      }
    };

    await recurse(driveItemPath, "");
    return entries;
  }

  private async graphGetRaw(pathOrUrl: string): Promise<any> {
    await this.ensureToken();
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `https://graph.microsoft.com/v1.0${pathOrUrl}`;
    const resp = await requestUrl({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    return resp.json;
  }

  async readFile(cloudFolder: string, relativePath: string): Promise<ArrayBuffer> {
    const itemPath = this.encodePath(cloudFolder, relativePath);
    await this.ensureToken();
    const resp = await requestUrl({
      url: `https://graph.microsoft.com/v1.0${itemPath}:/content`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    return resp.arrayBuffer;
  }

  async writeFile(
    cloudFolder: string,
    relativePath: string,
    content: ArrayBuffer,
    _mtime: number
  ): Promise<void> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    // Ensure parent folders exist
    const parts = fullPath.split("/").filter(Boolean);
    if (parts.length > 1) {
      const parentParts = parts.slice(0, -1);
      let currentPath = "";
      for (const part of parentParts) {
        const parentOfCurrent = currentPath === "" ? "/me/drive/root" : `/me/drive/root:/${currentPath}:`;
        try {
          await this.graphPost(`${parentOfCurrent}/children`, {
            name: part,
            folder: {},
            "@microsoft.graph.conflictBehavior": "fail",
          });
        } catch { /* folder may already exist */ }
        currentPath = currentPath ? `${currentPath}/${part}` : part;
      }
    }
    // For files < 4MB, use simple upload
    await this.graphPut(`/me/drive/root:${fullPath}:/content`, content);
  }

  async deleteFile(cloudFolder: string, relativePath: string): Promise<void> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    await this.graphDelete(`/me/drive/root:${fullPath}:`);
  }

  async mkdir(cloudFolder: string, relativePath: string): Promise<void> {
    const parentPath = joinCloudPath(cloudFolder, relativePath);
    const parts = parentPath.split("/").filter(Boolean);
    const folderName = parts.pop()!;
    const parent =
      parts.length === 0
        ? "/me/drive/root"
        : `/me/drive/root:/${parts.join("/")}:`;
    try {
      await this.graphPost(`${parent}/children`, {
        name: folderName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      });
    } catch (e: any) {
      // Ignore if already exists (409 conflict)
      if (e?.status === 409 || e?.message?.includes("nameAlreadyExists")) return;
      throw e;
    }
  }

  async stat(cloudFolder: string, relativePath: string): Promise<FileEntry | null> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    try {
      const data = await this.graphGet(
        `/me/drive/root:${fullPath}:?$select=name,size,lastModifiedDateTime,folder,file`
      );
      return {
        path: relativePath,
        mtime: new Date(data.lastModifiedDateTime).getTime(),
        size: data.size || 0,
        isFolder: !!data.folder,
        hash: data.file?.hashes?.quickXorHash,
      };
    } catch {
      return null;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.graphGet("/me/drive");
      return true;
    } catch {
      return false;
    }
  }

  async getDisplayName(): Promise<string> {
    try {
      const me = await this.graphGet("/me");
      return me.displayName || "OneDrive";
    } catch {
      return "OneDrive";
    }
  }
}
