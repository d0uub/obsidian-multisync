import type { FileEntry } from "../types";

/**
 * Cloud provider interface.
 * Each cloud vendor (Dropbox, OneDrive, GDrive) implements this.
 * All paths are relative to the configured cloud folder root.
 */
export interface ICloudProvider {
  /** Provider kind identifier */
  readonly kind: string;

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
    mtime: number
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
   * Human-readable display name for this provider instance.
   */
  getDisplayName(): Promise<string>;
}
