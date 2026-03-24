import type { FileEntry } from "../types";
import type { CloudFileEntry } from "../utils/cloudRegistry";

/** A file that exists on cloud but cannot be synced (native format, unsupported type, etc.) */
export interface UnsyncableFile {
  /** Path relative to cloud folder root */
  path: string;
  /** Display name */
  name: string;
  /** Size in bytes (0 if unknown) */
  size: number;
  /** Reason it can't be synced */
  reason: string;
}

/** A single delta change from the cloud provider */
export interface DeltaChange {
  /** Cloud-provider-specific unique ID */
  id: string;
  /** True if the item was deleted */
  deleted: boolean;
  /** Full path from drive root (e.g. "folder/sub/file.md"). Absent for some OneDrive deletes. */
  path?: string;
  /** File entry details (only for non-deleted items) */
  entry?: CloudFileEntry;
}

/**
 * Cloud provider interface.
 * Each cloud vendor (Dropbox, OneDrive, GDrive) implements this.
 * All paths are relative to the configured cloud folder root.
 */
export interface ICloudProvider {
  /** Provider kind identifier */
  readonly kind: string;

  /** Files found on cloud that cannot be synced (native formats, unsupported types). Populated by listFiles(). */
  unsyncableFiles: UnsyncableFile[];

  /**
   * List all files/folders recursively under the cloud root folder.
   * Returns flat array of FileEntry with paths relative to cloud root.
   */
  listFiles(cloudFolder: string): Promise<FileEntry[]>;

  /**
   * Read file content from cloud.
   * @param cloudFolder - the cloud root folder
   * @param relativePath - path relative to cloudFolder
   * @returns file content as ArrayBuffer
   */
  readFile(cloudFolder: string, relativePath: string): Promise<ArrayBuffer>;

  /**
   * Write (create or overwrite) a file to cloud.
   * @param cloudFolder - the cloud root folder
   * @param relativePath - path relative to cloudFolder
   * @param content - file content
   * @param mtime - modification timestamp to set on cloud
   */
  writeFile(
    cloudFolder: string,
    relativePath: string,
    content: ArrayBuffer,
    mtime: number,
    ctime?: number
  ): Promise<void>;

  /**
   * Delete a file or folder from cloud.
   */
  deleteFile(cloudFolder: string, relativePath: string): Promise<void>;

  /**
   * Create a folder on cloud.
   */
  mkdir(cloudFolder: string, relativePath: string): Promise<void>;

  /**
   * Ensure the cloud root folder exists.
   * Called before listFiles and other operations that require the folder to exist.
   * Must be idempotent — no-op if folder already exists.
   */
  ensureFolder(cloudFolder: string): Promise<void>;

  /**
   * Get metadata for a single file/folder.
   * Returns null if not found.
   */
  stat(
    cloudFolder: string,
    relativePath: string
  ): Promise<FileEntry | null>;

  /**
   * Test connectivity and auth. Returns true if OK.
   */
  testConnection(): Promise<boolean>;

  /**
   * Get list of recently deleted file paths from cloud using incremental change tracking.
   * @param cloudFolder - cloud root folder
   * @param deltaToken - previous delta token (empty string for first run)
   * @param idToPathMap - optional cloud-ID → path lookup from the cloud registry (for providers where delta doesn't include path in deleted entries)
   * @returns deleted paths relative to cloudFolder + new delta token for next call
   */
  getDeletedItems(cloudFolder: string, deltaToken: string, idToPathMap?: Record<string, string>): Promise<{ deleted: string[]; newDeltaToken: string }>;

  /**
   * Full-account delta sync: enumerate all files on first call (no token),
   * or return only changes since the last token. Paths are from drive root.
   * @param deltaToken - empty string for full enumeration, otherwise last saved token
   * @returns changes array + new delta token
   */
  syncAccountDelta(deltaToken: string): Promise<{ changes: DeltaChange[]; newDeltaToken: string; isFullEnum: boolean }>;

  /**
   * Get a baseline delta token without enumerating files.
   * Used when the registry is populated via listFiles() and we just need a token
   * to track future incremental changes.
   */
  getBaselineDeltaToken(): Promise<string>;

  /**
   * Human-readable display name for this provider instance.
   */
  getDisplayName(): Promise<string>;

  /**
   * Get storage quota info.
   * Returns used/total in bytes, or null if unsupported.
   */
  getQuota(): Promise<{ used: number; total: number } | null>;
}
