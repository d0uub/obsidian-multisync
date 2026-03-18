// ============================================================
// Core types for obsidian-multisync
// ============================================================

/** Represents a single file/folder entry from either local or cloud */
export interface FileEntry {
  /** Relative path from sync root, e.g. "notes/todo.md". Folders end with "/" */
  path: string;
  /** Last modified timestamp in ms (epoch) */
  mtime: number;
  /** File size in bytes (0 for folders) */
  size: number;
  /** True if this entry is a folder */
  isFolder: boolean;
  /** Optional content hash for smarter diff */
  hash?: string;
}

/** Supported cloud provider types */
export type CloudProviderType = "dropbox" | "onedrive" | "gdrive";

/** A registered cloud account */
export interface CloudAccount {
  id: string;
  type: CloudProviderType;
  /** Display name, e.g. "Work OneDrive" */
  name: string;
  /** OAuth tokens / credentials (provider-specific) */
  credentials: Record<string, string>;
}

/**
 * A sync rule binding a cloud account+folder to a local vault folder.
 * Example: OneDrive(account1)/officefolder ↔ /officefolder
 */
export interface SyncRule {
  id: string;
  accountId: string;
  /** Cloud-side folder path, e.g. "/officefolder" */
  cloudFolder: string;
  /** Local vault folder path (relative to vault root), e.g. "officefolder" */
  localFolder: string;
}

/**
 * The 5 independent sync operations.
 * - local-update:  file changed locally, push newer version to cloud
 * - cloud-update:  file changed on cloud, pull newer version to local
 * - local-add:     new file in local (not in snapshot) → push to cloud
 * - cloud-add:     new file in cloud (not in snapshot) → pull to local
 * - local-delete:  file deleted locally (was in snapshot) → delete from cloud
 * - cloud-delete:  file deleted on cloud (was in snapshot) → delete from local
 */
export type SyncOpType =
  | "local-update"
  | "cloud-update"
  | "local-add"
  | "cloud-add"
  | "local-delete"
  | "cloud-delete";

/** A single step in the sync pipeline: which rule + which operation */
export interface SyncStep {
  ruleId: string;
  operation: SyncOpType;
}

/** An action item produced by an operation detector */
export interface SyncAction {
  /** Which operation produced this */
  operation: SyncOpType;
  /** File path relative to sync root */
  path: string;
  isFolder: boolean;
  /** The source entry (local or cloud depending on operation) */
  sourceEntry?: FileEntry;
}

/** Snapshot = record of file states after last successful sync, keyed by path */
export type Snapshot = Record<string, FileEntry>;

/** Plugin settings persisted to data.json */
export interface MultiSyncSettings {
  accounts: CloudAccount[];
  rules: SyncRule[];
  /** User-defined pipeline ordering */
  pipeline: SyncStep[];
  /** Snapshots per sync rule ID */
  snapshots: Record<string, Snapshot>;
}

export const DEFAULT_SETTINGS: MultiSyncSettings = {
  accounts: [],
  rules: [],
  pipeline: [],
  snapshots: {},
};
