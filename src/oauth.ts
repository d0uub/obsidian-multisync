import { requestUrl, Platform } from "obsidian";

/**
 * OAuth 2.0 PKCE helpers for all cloud providers.
 * Uses obsidian:// URI scheme for callbacks, with manual code paste fallback on Linux.
 */

export const CALLBACK_DROPBOX = "multisync-cb-dropbox";
export const CALLBACK_ONEDRIVE = "multisync-cb-onedrive";
export const CALLBACK_GDRIVE = "multisync-cb-gdrive";

/** PKCE: Generate code_verifier and code_challenge (S256) */
export async function generatePKCE(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = base64UrlEncode(array);

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64UrlEncode(new Uint8Array(digest));

  return { verifier, challenge };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Check if we need manual code paste (Linux desktop without reliable URI handler) */
export function needsManualPaste(): boolean {
  if (!Platform.isDesktopApp) return false;
  if (Platform.isMacOS) return false;
  const ua = (navigator.userAgent || "").toLowerCase();
  return /linux|ubuntu|debian|fedora|centos/.test(ua);
}

// ═══════════════════════════════════════════════
// DROPBOX
// ═══════════════════════════════════════════════

const DROPBOX_APP_KEY = "y8k73tvwvsg3kbi";

export interface DropboxAuthResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account_id: string;
  uid: string;
}

export async function getDropboxAuthUrl(
  _appKey: string,
  manual: boolean
): Promise<{ authUrl: string; verifier: string }> {
  const { verifier, challenge } = await generatePKCE();
  const redirectUri = manual ? undefined : `obsidian://${CALLBACK_DROPBOX}`;

  const params = new URLSearchParams({
    client_id: DROPBOX_APP_KEY,
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
}

export async function exchangeDropboxCode(
  _appKey: string,
  code: string,
  verifier: string,
  manual: boolean
): Promise<DropboxAuthResult> {
  const body: Record<string, string> = {
    code,
    grant_type: "authorization_code",
    code_verifier: verifier,
    client_id: DROPBOX_APP_KEY,
  };
  if (!manual) {
    body.redirect_uri = `obsidian://${CALLBACK_DROPBOX}`;
  }

  const resp = await requestUrl({
    url: "https://api.dropboxapi.com/oauth2/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return resp.json as DropboxAuthResult;
}

// ═══════════════════════════════════════════════
// ONEDRIVE
// ═══════════════════════════════════════════════

export interface OneDriveAuthResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

const ONEDRIVE_SCOPES = "User.Read Files.ReadWrite.All offline_access";
const ONEDRIVE_AUTHORITY = "https://login.microsoftonline.com/common";
const ONEDRIVE_CLIENT_ID = "03beb548-4548-4835-ba4e-18ac1f469442";

export async function getOneDriveAuthUrl(
  _clientId: string,
  manual: boolean
): Promise<{ authUrl: string; verifier: string }> {
  const { verifier, challenge } = await generatePKCE();
  const redirectUri = manual
    ? "https://login.microsoftonline.com/common/oauth2/nativeclient"
    : `obsidian://${CALLBACK_ONEDRIVE}`;

  const params = new URLSearchParams({
    client_id: ONEDRIVE_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: ONEDRIVE_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_mode: "query",
  });

  return {
    authUrl: `${ONEDRIVE_AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`,
    verifier,
  };
}

export async function exchangeOneDriveCode(
  _clientId: string,
  code: string,
  verifier: string,
  manual: boolean
): Promise<OneDriveAuthResult> {
  const redirectUri = manual
    ? "https://login.microsoftonline.com/common/oauth2/nativeclient"
    : `obsidian://${CALLBACK_ONEDRIVE}`;

  const resp = await requestUrl({
    url: `${ONEDRIVE_AUTHORITY}/oauth2/v2.0/token`,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ONEDRIVE_CLIENT_ID,
      scope: ONEDRIVE_SCOPES,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
  });
  return resp.json as OneDriveAuthResult;
}

// ═══════════════════════════════════════════════
// GOOGLE DRIVE
// ═══════════════════════════════════════════════

export interface GDriveAuthResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

const GDRIVE_SCOPES = "https://www.googleapis.com/auth/drive.file";

export async function getGDriveAuthUrl(
  clientId: string,
  manual: boolean
): Promise<{ authUrl: string; verifier: string }> {
  const { verifier, challenge } = await generatePKCE();
  // GDrive: for manual paste, use urn:ietf:wg:oauth:2.0:oob (deprecated but still works for installed apps)
  // or use localhost redirect. We'll use the copy-paste flow.
  const redirectUri = manual
    ? "urn:ietf:wg:oauth:2.0:oob"
    : `obsidian://${CALLBACK_GDRIVE}`;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
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
}

export async function exchangeGDriveCode(
  clientId: string,
  clientSecret: string,
  code: string,
  verifier: string,
  manual: boolean
): Promise<GDriveAuthResult> {
  const redirectUri = manual
    ? "urn:ietf:wg:oauth:2.0:oob"
    : `obsidian://${CALLBACK_GDRIVE}`;

  const resp = await requestUrl({
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
  });
  return resp.json as GDriveAuthResult;
}
