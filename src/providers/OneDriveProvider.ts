import type { ICloudProvider, DeltaChange } from "./ICloudProvider";
import type { FileEntry } from "../types";
import type { ProviderMeta } from "./registry";
import type { CloudFileEntry } from "../utils/cloudRegistry";
import { requestUrl } from "obsidian";
import { normalizePath, joinCloudPath } from "../utils/helpers";
import { generatePKCE } from "./registry";

const CLIENT_ID = "03beb548-4548-4835-ba4e-18ac1f469442";
const SCOPES = "User.Read Files.ReadWrite.All offline_access";
const AUTHORITY = "https://login.microsoftonline.com/common";
const CALLBACK = "multisync-cb-onedrive";
const SVG_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.453 9.95q.961.058 1.787.468.826.41 1.442 1.066.615.657.966 1.512.352.856.352 1.816 0 1.008-.387 1.893-.386.885-1.049 1.547-.662.662-1.546 1.049-.885.387-1.893.387H6q-1.242 0-2.332-.475-1.09-.475-1.904-1.29-.815-.814-1.29-1.903Q0 14.93 0 13.688q0-.985.31-1.887.311-.903.862-1.658.55-.756 1.324-1.325.774-.568 1.711-.861.434-.129.85-.187.416-.06.861-.082h.012q.515-.786 1.207-1.413.691-.627 1.5-1.066.808-.44 1.705-.668.896-.229 1.845-.229 1.278 0 2.456.417 1.177.416 2.144 1.16.967.744 1.658 1.78.692 1.038 1.008 2.28zm-7.265-4.137q-1.325 0-2.52.544-1.195.545-2.04 1.565.446.117.85.299.405.181.792.416l4.78 2.86 2.731-1.15q.27-.117.545-.204.276-.088.58-.147-.293-.937-.855-1.705-.563-.768-1.319-1.318-.755-.551-1.658-.856-.902-.304-1.886-.304zM2.414 16.395l9.914-4.184-3.832-2.297q-.586-.351-1.23-.539-.645-.188-1.325-.188-.914 0-1.722.364-.809.363-1.412.978-.604.616-.955 1.436-.352.82-.352 1.723 0 .703.234 1.423.235.721.68 1.284zm16.711 1.793q.563 0 1.078-.176.516-.176.961-.516l-7.23-4.324-10.301 4.336q.527.328 1.13.504.604.175 1.237.175zm3.012-1.852q.363-.727.363-1.523 0-.774-.293-1.407t-.791-1.072q-.498-.44-1.166-.68-.668-.24-1.406-.24-.422 0-.838.1t-.815.252q-.398.152-.785.334-.386.181-.761.345Z"/></svg>';

export const ONEDRIVE_META: ProviderMeta = {
  type: "onedrive",
  label: "OneDrive",
  svgIcon: SVG_ICON,
  callbackProtocol: CALLBACK,
  credentialFields: [
    { key: "accessToken", label: "Access Token", secret: true },
    { key: "refreshToken", label: "Refresh Token", secret: true },
  ],
  getMissingCreds: () => [],
  autoFillCreds: (creds) => {
    if (!creds.clientId) creds.clientId = CLIENT_ID;
  },
  getAuthUrl: async (_creds, manual) => {
    const { verifier, challenge } = await generatePKCE();
    const redirectUri = manual
      ? "https://login.microsoftonline.com/common/oauth2/nativeclient"
      : `obsidian://${CALLBACK}`;
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      response_mode: "query",
    });
    return {
      authUrl: `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`,
      verifier,
    };
  },
  exchangeCode: async (_creds, code, verifier, manual) => {
    const redirectUri = manual
      ? "https://login.microsoftonline.com/common/oauth2/nativeclient"
      : `obsidian://${CALLBACK}`;
    const resp = await requestUrl({
      url: `${AUTHORITY}/oauth2/v2.0/token`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: SCOPES,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });
    const data = resp.json;
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
  },
  createInstance: (creds, onTokenRefreshed) => {
    return new OneDriveProvider(
      creds.accessToken || "",
      creds.refreshToken || "",
      creds.clientId || CLIENT_ID,
      parseInt(creds.tokenExpiry || "0", 10),
      onTokenRefreshed,
    );
  },
};

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

    // Ensure the cloud folder exists before listing
    if (prefix) {
      await this.ensureFolder(cloudFolder);
    }

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
          cloudId: item.id,
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

  async ensureFolder(cloudFolder: string): Promise<void> {
    const prefix = (cloudFolder === "/" || cloudFolder === "")
      ? ""
      : (cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder);
    if (!prefix) return;
    await this.mkdir("", prefix).catch(() => {});
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

  async getDeletedItems(cloudFolder: string, deltaToken: string, idToPathMap?: Record<string, string>): Promise<{ deleted: string[]; newDeltaToken: string }> {
    const prefix = (cloudFolder === "/" || cloudFolder === "")
      ? ""
      : (cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder) + "/";

    const deleted: string[] = [];
    let newDeltaToken = deltaToken;
    let sawDeletedEntries = false;

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
            sawDeletedEntries = true;

            // Try to resolve the path: first from item.name + parentReference, then from registry
            let relativePath: string | undefined;

            if (item.name) {
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
              relativePath = prefix ? fullPath.substring(prefix.length) : fullPath;
            } else if (item.id && idToPathMap?.[item.id]) {
              // Fallback: look up ID in cloud registry
              relativePath = idToPathMap[item.id];
            }

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

      // If delta reported deletions but we couldn't extract file names, log a warning.
      // We do NOT fall back to "*" sentinel — safer to miss a cloud-delete than risk mass deletion.
      if (sawDeletedEntries && deleted.length === 0) {
        console.warn("OneDrive: delta saw deleted entries but couldn't resolve paths (no name, no registry match) — skipping cloud-delete this cycle");
      }
    } catch (e) {
      // If token is stale (410 Gone), reset and return empty — next sync will re-baseline
      console.warn("OneDrive: delta query failed, resetting token", e);
      newDeltaToken = "";
    }
    return { deleted, newDeltaToken };
  }

  async syncAccountDelta(deltaToken: string): Promise<{ changes: DeltaChange[]; newDeltaToken: string; isFullEnum: boolean }> {
    const isFullEnum = !deltaToken;
    const changes: DeltaChange[] = [];

    try {
      let url: string;
      if (!deltaToken) {
        // Full enumeration — no token, get everything from root
        url = `/me/drive/root/delta?$select=id,name,size,lastModifiedDateTime,createdDateTime,folder,file,deleted,parentReference&$top=200`;
      } else {
        // Incremental — use stored deltaLink
        url = deltaToken.startsWith("/")
          ? deltaToken
          : `/me/drive/root/delta(token='${deltaToken}')`;
      }

      let newDeltaToken = deltaToken;
      while (url) {
        const data = await this.graphGetRaw(url);
        for (const item of data.value || []) {
          if (item.root) continue; // skip drive root itself

          // Reconstruct full path from parentReference
          let itemPath: string | undefined;
          if (item.name) {
            const parentPath = item.parentReference?.path || "";
            const rootPrefix = "/drive/root:";
            let itemFolder = "";
            if (parentPath.includes(rootPrefix)) {
              const raw = parentPath.substring(parentPath.indexOf(rootPrefix) + rootPrefix.length);
              itemFolder = decodeURIComponent(raw.startsWith("/") ? raw.substring(1) : raw);
            }
            itemPath = itemFolder ? `${itemFolder}/${item.name}` : item.name;
          }

          if (item.deleted) {
            changes.push({ id: item.id, deleted: true, path: itemPath });
          } else {
            const isFolder = !!item.folder;
            const entry: CloudFileEntry = {
              id: item.id,
              path: isFolder ? (itemPath || "") + "/" : itemPath || "",
              mtime: new Date(item.lastModifiedDateTime).getTime(),
              size: item.size || 0,
              isFolder,
              hash: item.file?.hashes?.quickXorHash,
              ctime: item.createdDateTime ? new Date(item.createdDateTime).getTime() : undefined,
            };
            changes.push({ id: item.id, deleted: false, path: itemPath, entry });
          }
        }

        if (data["@odata.deltaLink"]) {
          newDeltaToken = (data["@odata.deltaLink"] as string).replace("https://graph.microsoft.com/v1.0", "");
          url = "";
        } else if (data["@odata.nextLink"]) {
          url = (data["@odata.nextLink"] as string).replace("https://graph.microsoft.com/v1.0", "");
        } else {
          url = "";
        }
      }

      return { changes, newDeltaToken, isFullEnum };
    } catch (e: any) {
      // 410 Gone = token expired — reset and do full enum next time
      if (e?.status === 410) {
        console.warn("OneDrive: delta token expired (410), will re-enumerate next sync");
        return { changes: [], newDeltaToken: "", isFullEnum: false };
      }
      throw e;
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
