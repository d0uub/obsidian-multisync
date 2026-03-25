import type { ICloudProvider } from "./ICloudProvider";
import type { CloudProviderType } from "../types";
import { Platform } from "obsidian";

// ─── PKCE helpers (shared by all providers) ───

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = base64UrlEncode(array);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function needsManualPaste(): boolean {
  if (!Platform.isDesktopApp) return false;
  if (Platform.isMacOS) return false;
  return Platform.isLinux;
}

// ─── Provider metadata interface ───

export interface CredentialField {
  key: string;
  label: string;
  secret?: boolean;
}

export interface ProviderMeta {
  /** Provider type identifier */
  type: CloudProviderType;
  /** Display label */
  label: string;
  /** 16x16 SVG icon markup */
  svgIcon: string;
  /** obsidian:// protocol callback name */
  callbackProtocol: string;
  /** Credential fields shown in settings (exclude auto-filled ones) */
  credentialFields: CredentialField[];
  /** Return missing required credential keys before OAuth can start */
  getMissingCreds(creds: Record<string, string>): string[];
  /** Auto-fill default credentials (e.g., hardcoded app keys) */
  autoFillCreds(creds: Record<string, string>): void;
  /** Generate OAuth authorization URL.
   *  If codePromise is returned, the caller should await it to get the auth code
   *  (used by providers that start a loopback server, e.g. GDrive). */
  getAuthUrl(creds: Record<string, string>, manual: boolean): Promise<{ authUrl: string; verifier: string; codePromise?: Promise<string> }>;
  /** Exchange authorization code for tokens */
  exchangeCode(creds: Record<string, string>, code: string, verifier: string, manual: boolean): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;
  /** Create a provider instance */
  createInstance(
    creds: Record<string, string>,
    onTokenRefreshed: (token: string, refresh: string, expiry: number) => void
  ): ICloudProvider;
}

// ─── Import provider metas ───

import { DROPBOX_META } from "./DropboxProvider";
import { ONEDRIVE_META } from "./OneDriveProvider";
import { GDRIVE_META } from "./GDriveProvider";

/** All registered providers, keyed by type */
export const PROVIDERS: Record<CloudProviderType, ProviderMeta> = {
  dropbox: DROPBOX_META,
  onedrive: ONEDRIVE_META,
  gdrive: GDRIVE_META,
};

/** Ordered list for UI dropdowns */
export const PROVIDER_LIST: ProviderMeta[] = [
  DROPBOX_META,
  ONEDRIVE_META,
  GDRIVE_META,
];
