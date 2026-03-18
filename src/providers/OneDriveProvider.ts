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

  private refreshPromise: Promise<void> | null = null;

  private async ensureToken(): Promise<void> {
    if (Date.now() < this.tokenExpiry - 60000) return;
    // Serialize concurrent refresh attempts
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefreshToken();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefreshToken(): Promise<void> {
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

  /** Retry wrapper for Graph API calls with exponential backoff on 429/503 */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        const status = e?.status || (e?.message?.match(/status (\d+)/)?.[1] && parseInt(e.message.match(/status (\d+)/)[1]));
        if (status === 401 && attempt < maxRetries) {
          this.tokenExpiry = 0; // force refresh
          await this.ensureToken();
          continue;
        }
        if ((status === 429 || status === 503) && attempt < maxRetries) {
          // Retry-After header or exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
  }

  private async graphGet(path: string): Promise<any> {
    await this.ensureToken();
    return this.withRetry(async () => {
      const resp = await requestUrl({
        url: `https://graph.microsoft.com/v1.0${path}`,
        method: "GET",
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      return resp.json;
    });
  }

  private async graphPut(path: string, content: ArrayBuffer): Promise<any> {
    await this.ensureToken();
    return this.withRetry(async () => {
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
    });
  }

  private async graphDelete(path: string): Promise<void> {
    await this.ensureToken();
    await this.withRetry(async () => {
      await requestUrl({
        url: `https://graph.microsoft.com/v1.0${path}`,
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
    });
  }

  private async graphPost(path: string, body: Record<string, unknown>): Promise<any> {
    await this.ensureToken();
    return this.withRetry(async () => {
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
    });
  }

  private async graphPatch(path: string, body: Record<string, unknown>): Promise<any> {
    await this.ensureToken();
    return this.withRetry(async () => {
      const resp = await requestUrl({
        url: `https://graph.microsoft.com/v1.0${path}`,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return resp.json;
    });
  }

  /** Ensure a cloud path always starts with / for Graph API */
  private ensureLeadingSlash(p: string): string {
    return p.startsWith("/") ? p : "/" + p;
  }

  /** Percent-encode each segment of a cloud path for Graph API (spaces, #, %, etc.) */
  private encodeGraphPath(p: string): string {
    return p.split("/").map(seg => encodeURIComponent(seg)).join("/");
  }

  private encodePath(cloudFolder: string, relativePath?: string): string {
    const full = relativePath
      ? joinCloudPath(cloudFolder, relativePath)
      : cloudFolder;
    if (full === "/" || full === "") return "/me/drive/root";
    return `/me/drive/root:${this.encodeGraphPath(this.ensureLeadingSlash(full))}`;
  }

  async listFiles(cloudFolder: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    const prefix = (cloudFolder === "/" || cloudFolder === "")
      ? ""
      : (cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder);

    // Use delta API for flat enumeration of entire tree (much faster than recursive children)
    const deltaPath = prefix
      ? `/me/drive/root:/${this.encodeGraphPath(prefix)}:/delta?$select=id,name,size,lastModifiedDateTime,createdDateTime,folder,file,deleted,parentReference&$top=200`
      : `/me/drive/root/delta?$select=id,name,size,lastModifiedDateTime,createdDateTime,folder,file,deleted,parentReference&$top=200`;

    let url: string = deltaPath;
    while (url) {
      let data: any;
      try {
        data = await this.graphGetRaw(url);
      } catch (e: any) {
        if (e?.status === 404 || e?.message?.includes("404")) return entries;
        throw e;
      }
      for (const item of data.value || []) {
        // Skip root item itself (has no parentReference path matching our prefix)
        if (item.root) continue;
        // Skip deleted items
        if (item.deleted) continue;

        // Reconstruct relative path from parentReference
        const parentPath = item.parentReference?.path || "";
        const rootPrefix = "/drive/root:";
        let itemFolder = "";
        if (parentPath.includes(rootPrefix)) {
          const raw = parentPath.substring(parentPath.indexOf(rootPrefix) + rootPrefix.length);
          itemFolder = decodeURIComponent(raw.startsWith("/") ? raw.substring(1) : raw);
        }
        const fullPath = itemFolder ? `${itemFolder}/${item.name}` : item.name;

        // Filter to items under our cloudFolder
        let relativePath: string;
        if (prefix) {
          if (!fullPath.startsWith(prefix + "/") && fullPath !== prefix) continue;
          relativePath = fullPath.substring(prefix.length + 1);
        } else {
          relativePath = fullPath;
        }
        if (!relativePath) continue;

        const isFolder = !!item.folder;
        entries.push({
          path: isFolder ? relativePath + "/" : relativePath,
          mtime: new Date(item.lastModifiedDateTime).getTime(),
          size: item.size || 0,
          isFolder,
          hash: item.file?.hashes?.quickXorHash,
          ctime: item.createdDateTime ? new Date(item.createdDateTime).getTime() : undefined,
        });
      }

      if (data["@odata.nextLink"]) {
        url = (data["@odata.nextLink"] as string).replace("https://graph.microsoft.com/v1.0", "");
      } else {
        url = "";
      }
    }

    return entries;
  }

  private async graphGetRaw(pathOrUrl: string): Promise<any> {
    await this.ensureToken();
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `https://graph.microsoft.com/v1.0${pathOrUrl}`;
    return this.withRetry(async () => {
      const resp = await requestUrl({
        url,
        method: "GET",
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      return resp.json;
    });
  }

  async readFile(cloudFolder: string, relativePath: string): Promise<ArrayBuffer> {
    const itemPath = this.encodePath(cloudFolder, relativePath);
    // Get pre-authenticated download URL (avoids 302→401 CORS issue with /content)
    const meta = await this.graphGet(`${itemPath}?select=id,@microsoft.graph.downloadUrl`);
    const downloadUrl = meta["@microsoft.graph.downloadUrl"];
    if (!downloadUrl) throw new Error("No download URL for " + relativePath);
    const resp = await requestUrl({ url: downloadUrl, method: "GET" });
    return resp.arrayBuffer;
  }

  async writeFile(
    cloudFolder: string,
    relativePath: string,
    content: ArrayBuffer,
    mtime: number,
    ctime?: number
  ): Promise<void> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    // Ensure parent folders exist
    const parts = fullPath.split("/").filter(Boolean);
    if (parts.length > 1) {
      const parentParts = parts.slice(0, -1);
      let currentPath = "";
      for (const part of parentParts) {
        const parentOfCurrent = currentPath === "" ? "/me/drive/root" : `/me/drive/root:/${this.encodeGraphPath(currentPath)}:`;
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
    const itemPath = `/me/drive/root:${this.encodeGraphPath(this.ensureLeadingSlash(fullPath))}:`;
    await this.graphPut(`${itemPath}/content`, content);
    // Set file timestamps to match local source
    if (mtime > 0) {
      try {
        const fsInfo: Record<string, string> = {
          lastModifiedDateTime: new Date(mtime).toISOString(),
        };
        if (ctime && ctime > 0) {
          fsInfo.createdDateTime = new Date(ctime).toISOString();
        }
        await this.graphPatch(itemPath, { fileSystemInfo: fsInfo });
      } catch { /* timestamp patch failed silently */ }
    }
  }

  async deleteFile(cloudFolder: string, relativePath: string): Promise<void> {
    const fullPath = joinCloudPath(cloudFolder, relativePath);
    await this.graphDelete(`/me/drive/root:${this.encodeGraphPath(this.ensureLeadingSlash(fullPath))}:`);
  }

  async mkdir(cloudFolder: string, relativePath: string): Promise<void> {
    const parentPath = joinCloudPath(cloudFolder, relativePath);
    const parts = parentPath.split("/").filter(Boolean);
    const folderName = parts.pop()!;
    const parent =
      parts.length === 0
        ? "/me/drive/root"
        : `/me/drive/root:/${this.encodeGraphPath(parts.join("/"))}:`;
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
        `/me/drive/root:${this.encodeGraphPath(this.ensureLeadingSlash(fullPath))}:?$select=name,size,lastModifiedDateTime,createdDateTime,folder,file`
      );
      return {
        path: relativePath,
        mtime: new Date(data.lastModifiedDateTime).getTime(),
        size: data.size || 0,
        isFolder: !!data.folder,
        hash: data.file?.hashes?.quickXorHash,
        ctime: data.createdDateTime ? new Date(data.createdDateTime).getTime() : undefined,
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

  async getDeletedItems(cloudFolder: string, deltaToken: string): Promise<{ deleted: string[]; newDeltaToken: string }> {
    const prefix = (cloudFolder === "/" || cloudFolder === "")
      ? ""
      : (cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder) + "/";

    const deleted: string[] = [];
    let newDeltaToken = deltaToken;

    try {
      // First call: get current deltaLink without enumerating (skip existing state)
      // Subsequent calls: use stored deltaLink to get changes since last sync
      let url: string;
      if (!deltaToken) {
        // First run — get "latest" token to establish baseline (no deletes on first sync)
        url = "/me/drive/root/delta?token=latest";
      } else {
        // Use stored delta link (may be full URL or token)
        url = deltaToken.startsWith("/")
          ? deltaToken
          : `/me/drive/root/delta(token='${deltaToken}')`;
      }

      while (url) {
        const data = await this.graphGetRaw(url);
        // Only process items if we have a previous token (not first run)
        if (deltaToken) {
          for (const item of data.value || []) {
            if (!item.deleted) continue;
            if (!item.name) continue;  // deleted items may lack name
            // Reconstruct the original path from parentReference
            const parentPath = item.parentReference?.path || "";
            const rootPrefix = "/drive/root:";
            let itemFolder = "";
            if (parentPath.includes(rootPrefix)) {
              itemFolder = parentPath.substring(parentPath.indexOf(rootPrefix) + rootPrefix.length);
              if (itemFolder.startsWith("/")) itemFolder = itemFolder.substring(1);
            }
            const fullPath = itemFolder ? `${itemFolder}/${item.name}` : item.name;

            // Filter to items under our cloudFolder
            if (prefix && !fullPath.startsWith(prefix)) continue;
            const relativePath = prefix ? fullPath.substring(prefix.length) : fullPath;
            if (relativePath) deleted.push(relativePath);
          }
        }

        if (data["@odata.deltaLink"]) {
          // Extract token or store the relative URL
          const link = data["@odata.deltaLink"] as string;
          newDeltaToken = link.replace("https://graph.microsoft.com/v1.0", "");
          url = "";
        } else if (data["@odata.nextLink"]) {
          url = (data["@odata.nextLink"] as string).replace("https://graph.microsoft.com/v1.0", "");
        } else {
          url = "";
        }
      }
    } catch (e) {
      // If token is stale (410 Gone), reset and return empty — next sync will re-baseline
      console.warn("MultiSync: delta query failed, resetting token", e);
      newDeltaToken = "";
    }
    return { deleted, newDeltaToken };
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
