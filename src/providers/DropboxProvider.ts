import type { ICloudProvider, DeltaChange, UnsyncableFile } from "./ICloudProvider";
import type { FileEntry } from "../types";
import type { ProviderMeta } from "./registry";
import type { CloudFileEntry } from "../utils/cloudRegistry";
import { requestUrl } from "obsidian";
import { normalizePath, joinCloudPath } from "../utils/helpers";
import { generatePKCE } from "./registry";

const APP_KEY = "y8k73tvwvsg3kbi";
const CALLBACK = "multisync-cb-dropbox";
const SVG_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z"/></svg>';

export const DROPBOX_META: ProviderMeta = {
  type: "dropbox",
  label: "Dropbox",
  svgIcon: SVG_ICON,
  callbackProtocol: CALLBACK,
  credentialFields: [
    { key: "accessToken", label: "Access Token", secret: true },
    { key: "refreshToken", label: "Refresh Token", secret: true },
  ],
  getMissingCreds: () => [],
  autoFillCreds: (creds) => {
    if (!creds.appKey) creds.appKey = APP_KEY;
  },
  getAuthUrl: async (_creds, manual) => {
    const { verifier, challenge } = await generatePKCE();
    const redirectUri = manual ? undefined : `obsidian://${CALLBACK}`;
    const params = new URLSearchParams({
      client_id: APP_KEY,
      response_type: "code",
      token_access_type: "offline",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    if (redirectUri) params.set("redirect_uri", redirectUri);
    return {
      authUrl: `https://www.dropbox.com/oauth2/authorize?${params.toString()}`,
      verifier,
    };
  },
  exchangeCode: async (_creds, code, verifier, manual) => {
    const body: Record<string, string> = {
      code,
      grant_type: "authorization_code",
      code_verifier: verifier,
      client_id: APP_KEY,
    };
    if (!manual) body.redirect_uri = `obsidian://${CALLBACK}`;
    const resp = await requestUrl({
      url: "https://api.dropboxapi.com/oauth2/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    const data = resp.json;
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
  },
  createInstance: (creds, onTokenRefreshed) => {
    return new DropboxProvider(
      creds.accessToken || "",
      creds.refreshToken || "",
      creds.appKey || APP_KEY,
      parseInt(creds.tokenExpiry || "0", 10),
      onTokenRefreshed,
    );
  },
};

/**
 * Dropbox implementation of ICloudProvider.
 * Uses Dropbox HTTP API v2 directly via Obsidian's requestUrl (no SDK needed at runtime).
 * The `dropbox` npm package types can be used for dev reference but we call REST directly
 * for Obsidian mobile compatibility.
 */
export class DropboxProvider implements ICloudProvider {
  readonly kind = "dropbox";
  unsyncableFiles: UnsyncableFile[] = [];
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

  private async apiRpc(endpoint: string, body: Record<string, unknown> | null): Promise<any> {
    await this.ensureToken();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await requestUrl({
          url: `https://api.dropboxapi.com/2${endpoint}`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : "null",
        });
        return resp.json;
      } catch (e: any) {
        if ((e?.status === 429 || e?.message?.includes("429")) && attempt < 2) {
          const wait = Math.pow(2, attempt + 1) * 1000;
          console.log(`Dropbox: rate limited, retrying in ${wait/1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
    throw new Error("Dropbox apiRpc: unexpected end of retry loop");
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
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
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
      } catch (e: any) {
        if ((e?.status === 429 || e?.message?.includes("429")) && attempt < 2) {
          const wait = Math.pow(2, attempt + 1) * 1000;
          console.log(`Dropbox: rate limited, retrying in ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
    throw new Error("Dropbox apiContent: unexpected end of retry loop");
  }

  async listFiles(cloudFolder: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    this.unsyncableFiles = [];
    const path = (!cloudFolder || cloudFolder === "/") ? "" : (cloudFolder.startsWith("/") ? cloudFolder : "/" + cloudFolder);

    // Ensure the cloud folder exists before listing
    if (path) {
      await this.ensureFolder(cloudFolder);
    }

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
        // Collect Dropbox Paper files as unsyncable
        if (relativePath.endsWith(".paper")) {
          this.unsyncableFiles.push({ path: relativePath, name: relativePath.split("/").pop()!, size: item.size || 0, reason: "Dropbox Paper" });
          continue;
        }
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
          cloudId: item.id,
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
    try {
      await this.apiRpc("/files/delete_v2", { path: fullPath });
    } catch (e: any) {
      // 409 = path not found (already deleted, e.g. parent folder was deleted first)
      if (e?.status === 409 || e?.message?.includes("not_found") || e?.message?.includes("409")) return;
      throw e;
    }
  }

  async mkdir(cloudFolder: string, relativePath: string): Promise<void> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    try {
      await this.apiRpc("/files/create_folder_v2", { path: fullPath });
    } catch (e: any) {
      // Ignore if folder already exists (Dropbox returns 409 conflict)
      if (e?.status === 409 || e?.message?.includes("conflict") || e?.message?.includes("409")) return;
      throw e;
    }
  }

  async ensureFolder(cloudFolder: string): Promise<void> {
    const path = (!cloudFolder || cloudFolder === "/") ? "" : (cloudFolder.startsWith("/") ? cloudFolder : "/" + cloudFolder);
    if (!path) return;
    try {
      await this.apiRpc("/files/create_folder_v2", { path });
    } catch { /* already exists — ignore */ }
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
      await this.apiRpc("/users/get_current_account", null);
      return true;
    } catch {
      return false;
    }
  }

  async getDeletedItems(cloudFolder: string, deltaToken: string, _idToPathMap?: Record<string, string>): Promise<{ deleted: string[]; newDeltaToken: string }> {
    const path = (!cloudFolder || cloudFolder === "/") ? "" : (cloudFolder.startsWith("/") ? cloudFolder : "/" + cloudFolder);
    const deleted: string[] = [];

    try {
      if (!deltaToken) {
        // First run — get a cursor baseline without enumerating existing files.
        // No deletes reported on first sync (same as OneDrive).
        const data = await this.apiRpc("/files/list_folder/get_latest_cursor", {
          path,
          recursive: true,
          include_deleted: true,
        });
        return { deleted: [], newDeltaToken: data.cursor };
      }

      // Subsequent runs — use stored cursor to get changes since last sync
      let cursor = deltaToken;
      let hasMore = true;
      while (hasMore) {
        let data: any;
        try {
          data = await this.apiRpc("/files/list_folder/continue", { cursor });
        } catch (e: any) {
          // Cursor may be invalidated (reset error) — re-establish baseline
          if (e?.message?.includes("reset") || e?.status === 409) {
            const fresh = await this.apiRpc("/files/list_folder/get_latest_cursor", {
              path,
              recursive: true,
              include_deleted: true,
            });
            return { deleted: [], newDeltaToken: fresh.cursor };
          }
          throw e;
        }
        for (const entry of data.entries || []) {
          if (entry[".tag"] !== "deleted") continue;
          // entry.path_display is the full path, strip the cloudFolder prefix
          const entryPath = entry.path_display || entry.path_lower || "";
          const relativePath = normalizePath(entryPath.substring(path.length));
          if (relativePath) deleted.push(relativePath);
        }
        cursor = data.cursor;
        hasMore = data.has_more;
      }
      // If Dropbox delta returned no deleted entries, return [] — safe default.
      // Propagation delays may cause missed deletions; next sync will catch them.
      return { deleted, newDeltaToken: cursor };
    } catch (e) {
      console.error("Dropbox getDeletedItems error:", e);
      return { deleted: [], newDeltaToken: deltaToken };
    }
  }

  async syncAccountDelta(deltaToken: string): Promise<{ changes: DeltaChange[]; newDeltaToken: string; isFullEnum: boolean }> {
    const isFullEnum = !deltaToken;
    const changes: DeltaChange[] = [];

    try {
      let cursor: string;
      let hasMore: boolean;

      if (!deltaToken) {
        // Full enumeration from root
        const data = await this.apiRpc("/files/list_folder", {
          path: "",
          recursive: true,
          include_deleted: false,
        });
        this.processDropboxDelta(data.entries || [], changes);
        cursor = data.cursor;
        hasMore = data.has_more;
      } else {
        // Incremental from stored cursor
        let data: any;
        try {
          data = await this.apiRpc("/files/list_folder/continue", { cursor: deltaToken });
        } catch (e: any) {
          // Cursor invalidated — re-enumerate
          if (e?.message?.includes("reset") || e?.status === 409) {
            console.warn("Dropbox: cursor invalidated, will re-enumerate");
            return { changes: [], newDeltaToken: "", isFullEnum: false };
          }
          throw e;
        }
        this.processDropboxDelta(data.entries || [], changes);
        cursor = data.cursor;
        hasMore = data.has_more;
      }

      while (hasMore) {
        const data = await this.apiRpc("/files/list_folder/continue", { cursor });
        this.processDropboxDelta(data.entries || [], changes);
        cursor = data.cursor;
        hasMore = data.has_more;
      }

      return { changes, newDeltaToken: cursor, isFullEnum };
    } catch (e: any) {
      console.error("Dropbox syncAccountDelta error:", e);
      return { changes: [], newDeltaToken: "", isFullEnum: false };
    }
  }

  async getBaselineDeltaToken(): Promise<string> {
    const data = await this.apiRpc("/files/list_folder/get_latest_cursor", {
      path: "",
      recursive: true,
      include_deleted: true,
    });
    return data.cursor || "";
  }

  /** Parse Dropbox entries into DeltaChange[] */
  private processDropboxDelta(entries: any[], changes: DeltaChange[]): void {
    for (const item of entries) {
      const tag = item[".tag"];
      // Dropbox path_display starts with /, strip leading slash for consistency
      const rawPath = (item.path_display || item.path_lower || "").replace(/^\//, "");

      if (tag === "deleted") {
        changes.push({ id: item.id || rawPath, deleted: true, path: rawPath });
      } else {
        const isFolder = tag === "folder";
        const entry: CloudFileEntry = {
          id: item.id || rawPath,
          path: isFolder ? rawPath + "/" : rawPath,
          mtime: item.client_modified
            ? new Date(item.client_modified).getTime()
            : item.server_modified
              ? new Date(item.server_modified).getTime()
              : 0,
          size: item.size || 0,
          isFolder,
          hash: item.content_hash,
        };
        changes.push({ id: item.id || rawPath, deleted: false, path: rawPath, entry });
      }
    }
  }

  async getDisplayName(): Promise<string> {
    try {
      const account = await this.apiRpc("/users/get_current_account", null);
      return account.name?.display_name || "Dropbox";
    } catch {
      return "Dropbox";
    }
  }

  async getQuota(): Promise<{ used: number; total: number } | null> {
    try {
      const data = await this.apiRpc("/users/get_space_usage", null);
      const used = data.used ?? 0;
      const alloc = data.allocation;
      const total = alloc?.allocated ?? alloc?.individual?.allocated ?? 0;
      return total > 0 ? { used, total } : null;
    } catch {
      return null;
    }
  }
}
