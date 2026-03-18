import type { ICloudProvider } from "./ICloudProvider";
import type { FileEntry } from "../types";
import { requestUrl } from "obsidian";
import { normalizePath, joinCloudPath } from "../utils/helpers";

/**
 * Dropbox implementation of ICloudProvider.
 * Uses Dropbox HTTP API v2 directly via Obsidian's requestUrl (no SDK needed at runtime).
 * The `dropbox` npm package types can be used for dev reference but we call REST directly
 * for Obsidian mobile compatibility.
 */
export class DropboxProvider implements ICloudProvider {
  readonly kind = "dropbox";
  private accessToken: string;
  private refreshToken: string;
  private appKey: string;
  private tokenExpiry: number;
  private onTokenRefreshed?: (token: string, refresh: string, expiry: number) => void;

  constructor(
    accessToken: string,
    refreshToken: string,
    appKey: string,
    tokenExpiry: number,
    onTokenRefreshed?: (token: string, refresh: string, expiry: number) => void
  ) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.appKey = appKey;
    this.tokenExpiry = tokenExpiry;
    this.onTokenRefreshed = onTokenRefreshed;
  }

  private async ensureToken(): Promise<void> {
    if (Date.now() < this.tokenExpiry - 60000) return;
    const resp = await requestUrl({
      url: "https://api.dropboxapi.com/oauth2/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${this.refreshToken}&client_id=${this.appKey}`,
    });
    const data = resp.json;
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    this.onTokenRefreshed?.(this.accessToken, this.refreshToken, this.tokenExpiry);
  }

  private async apiRpc(endpoint: string, body: Record<string, unknown>): Promise<any> {
    await this.ensureToken();
    const resp = await requestUrl({
      url: `https://api.dropboxapi.com/2${endpoint}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return resp.json;
  }

  private async apiContent(
    endpoint: string,
    apiArg: Record<string, unknown>,
    content?: ArrayBuffer
  ): Promise<{ json: any; arrayBuffer: ArrayBuffer }> {
    await this.ensureToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "Dropbox-API-Arg": JSON.stringify(apiArg),
    };
    if (content) {
      headers["Content-Type"] = "application/octet-stream";
    }
    const resp = await requestUrl({
      url: `https://content.dropboxapi.com/2${endpoint}`,
      method: "POST",
      headers,
      body: content,
    });
    let json: any = {};
    try {
      const resultHeader = resp.headers["dropbox-api-result"];
      if (resultHeader) json = JSON.parse(resultHeader);
    } catch { /* ignore */ }
    return { json, arrayBuffer: resp.arrayBuffer };
  }

  async listFiles(cloudFolder: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    const path = cloudFolder === "/" ? "" : cloudFolder;

    let result = await this.apiRpc("/files/list_folder", {
      path,
      recursive: true,
      include_deleted: false,
    });

    const processEntries = (items: any[]) => {
      for (const item of items) {
        const relativePath = normalizePath(
          item.path_display.substring(path.length)
        );
        if (!relativePath) continue;
        entries.push({
          path: item[".tag"] === "folder" ? relativePath + "/" : relativePath,
          mtime: item.client_modified
            ? new Date(item.client_modified).getTime()
            : item.server_modified
              ? new Date(item.server_modified).getTime()
              : 0,
          size: item.size || 0,
          isFolder: item[".tag"] === "folder",
          hash: item.content_hash,
        });
      }
    };

    processEntries(result.entries);
    while (result.has_more) {
      result = await this.apiRpc("/files/list_folder/continue", {
        cursor: result.cursor,
      });
      processEntries(result.entries);
    }
    return entries;
  }

  async readFile(cloudFolder: string, relativePath: string): Promise<ArrayBuffer> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    const { arrayBuffer } = await this.apiContent("/files/download", { path: fullPath });
    return arrayBuffer;
  }

  async writeFile(
    cloudFolder: string,
    relativePath: string,
    content: ArrayBuffer,
    mtime: number,
    _ctime?: number
  ): Promise<void> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    await this.apiContent(
      "/files/upload",
      {
        path: fullPath,
        mode: "overwrite",
        client_modified: new Date(mtime).toISOString().replace(/\.\d{3}Z$/, "Z"),
        mute: true,
      },
      content
    );
  }

  async deleteFile(cloudFolder: string, relativePath: string): Promise<void> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    await this.apiRpc("/files/delete_v2", { path: fullPath });
  }

  async mkdir(cloudFolder: string, relativePath: string): Promise<void> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    try {
      await this.apiRpc("/files/create_folder_v2", { path: fullPath });
    } catch (e: any) {
      // Ignore if folder already exists
      if (e?.message?.includes("conflict")) return;
      throw e;
    }
  }

  async stat(cloudFolder: string, relativePath: string): Promise<FileEntry | null> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    try {
      const meta = await this.apiRpc("/files/get_metadata", { path: fullPath });
      return {
        path: relativePath,
        mtime: meta.client_modified
          ? new Date(meta.client_modified).getTime()
          : 0,
        size: meta.size || 0,
        isFolder: meta[".tag"] === "folder",
        hash: meta.content_hash,
      };
    } catch {
      return null;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.apiRpc("/users/get_current_account", {});
      return true;
    } catch {
      return false;
    }
  }

  async getDeletedItems(_cloudFolder: string, _deltaToken: string): Promise<{ deleted: string[]; newDeltaToken: string }> {
    // TODO: Implement via Dropbox list_folder/continue cursor API
    return { deleted: [], newDeltaToken: _deltaToken };
  }

  async getDisplayName(): Promise<string> {
    try {
      const account = await this.apiRpc("/users/get_current_account", {});
      return account.name?.display_name || "Dropbox";
    } catch {
      return "Dropbox";
    }
  }
}
