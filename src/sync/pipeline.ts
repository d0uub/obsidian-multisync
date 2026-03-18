import type { App } from "obsidian";
import type {
  FileEntry,
  SyncAction,
  SyncStep,
  SyncRule,
  MultiSyncSettings,
} from "../types";
import type { ICloudProvider } from "../providers/ICloudProvider";
import { OPERATION_DETECTORS } from "./operations";
import { normalizePath } from "../utils/helpers";

/**
 * SyncPipeline orchestrator.
 * Executes an ordered array of SyncStep (ruleId + operation).
 * Uses event-driven delete tracking instead of snapshots.
 */

export interface PipelineContext {
  app: App;
  settings: MultiSyncSettings;
  providers: Map<string, ICloudProvider>;
  /** Callback to persist settings */
  saveSettings: () => Promise<void>;
  onProgress?: (msg: string) => void;
  onAction?: (action: SyncAction, step: SyncStep) => void;
  dryRun?: boolean;
}

interface ListCache {
  cloudList: FileEntry[];
  localList: FileEntry[];
}

export async function runPipeline(
  steps: SyncStep[],
  ctx: PipelineContext
): Promise<{ actionsExecuted: number; errors: string[] }> {
  const listCaches = new Map<string, ListCache>();
  let actionsExecuted = 0;
  const errors: string[] = [];

  for (const step of steps) {
    try {
      const rule = ctx.settings.rules.find((r) => r.id === step.ruleId);
      if (!rule) { errors.push(`Rule not found: ${step.ruleId}`); continue; }

      const account = ctx.settings.accounts.find((a) => a.id === rule.accountId);
      if (!account) { errors.push(`Account not found: ${rule.accountId}`); continue; }

      const provider = ctx.providers.get(account.id);
      if (!provider) { errors.push(`Provider not initialized for account: ${account.name}`); continue; }

      const cache = await getOrFetchLists(rule, provider, ctx, listCaches);
      const pendingDeletes = ctx.settings.pendingCloudDeletes[rule.id] || [];

      const detector = OPERATION_DETECTORS[step.operation];
      if (!detector) { errors.push(`Unknown operation: ${step.operation}`); continue; }

      // For cloud-delete, fetch deleted items from cloud vendor's delta API
      let cloudDeletedPaths: string[] = [];
      if (step.operation === "cloud-delete") {
        const deltaToken = ctx.settings.deltaTokens?.[account.id] || "";
        const result = await provider.getDeletedItems(rule.cloudFolder, deltaToken);
        cloudDeletedPaths = result.deleted;
        // Persist the new delta token for next sync
        if (!ctx.settings.deltaTokens) ctx.settings.deltaTokens = {};
        ctx.settings.deltaTokens[account.id] = result.newDeltaToken;
        await ctx.saveSettings();
      }

      const actions = detector(cache.cloudList, cache.localList, pendingDeletes, cloudDeletedPaths);
      ctx.onProgress?.(`[${rule.id}] ${step.operation}: ${actions.length} action(s)`);

      // Execute actions concurrently
      const concurrency = ctx.settings.concurrency || 4;
      let pendingSaves = 0;
      let i = 0;
      const runNext = async (): Promise<void> => {
        while (i < actions.length) {
          const action = actions[i++];
          try {
            ctx.onAction?.(action, step);
            if (!ctx.dryRun) {
              await executeAction(action, rule, provider, ctx);
              // If this was a local-delete or re-download (from pending), remove from pending list
              if (step.operation === "local-delete") {
                const pending = ctx.settings.pendingCloudDeletes[rule.id];
                if (pending) {
                  const idx = pending.findIndex(d => d.path === action.path);
                  if (idx >= 0) pending.splice(idx, 1);
                }
              }
              pendingSaves++;
              if (pendingSaves >= 20) {
                pendingSaves = 0;
                await ctx.saveSettings();
              }
            }
            actionsExecuted++;
          } catch (e: any) {
            errors.push(`Failed ${action.operation} ${action.path}: ${e?.message || e}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, actions.length) }, () => runNext()));
      if (pendingSaves > 0 && !ctx.dryRun) {
        await ctx.saveSettings();
      }

      if (actions.length > 0 && !ctx.dryRun) {
        listCaches.delete(rule.id);
      }
    } catch (e: any) {
      errors.push(`Step ${step.ruleId}/${step.operation} failed: ${e?.message || e}`);
    }
  }

  // Save settings after all steps
  if (!ctx.dryRun) {
    await ctx.saveSettings();
  }

  return { actionsExecuted, errors };
}

/** Execute a single sync action */
async function executeAction(
  action: SyncAction,
  rule: SyncRule,
  provider: ICloudProvider,
  ctx: PipelineContext
): Promise<void> {
  const { app } = ctx;
  const normalizedBase = normalizePath(rule.localFolder);

  /** Build vault path from relative sync path */
  const toVaultPath = (relativePath: string) =>
    normalizedBase ? `${normalizedBase}/${relativePath}` : relativePath;

  switch (action.operation) {
    case "local-update": {
      // Local file is newer → push to cloud
      const localPath = toVaultPath(action.path);
      const content = await app.vault.adapter.readBinary(localPath);
      await provider.writeFile(
        rule.cloudFolder,
        action.path,
        content,
        action.sourceEntry?.mtime || Date.now()
      );
      break;
    }
    case "cloud-update": {
      // Cloud file is newer → pull to local
      const content = await provider.readFile(rule.cloudFolder, action.path);
      const localPath = toVaultPath(action.path);
      await ensureLocalParentDir(app, localPath);
      const mtime = action.sourceEntry?.mtime || Date.now();
      await app.vault.adapter.writeBinary(localPath, content, { mtime });
      break;
    }
    case "local-add": {
      if (action.isFolder) {
        await provider.mkdir(rule.cloudFolder, action.path.replace(/\/$/, ""));
      } else {
        const localPath = toVaultPath(action.path);
        const content = await app.vault.adapter.readBinary(localPath);
        await provider.writeFile(
          rule.cloudFolder,
          action.path,
          content,
          action.sourceEntry?.mtime || Date.now()
        );
      }
      break;
    }
    case "cloud-add": {
      if (action.isFolder) {
        const localPath = toVaultPath(action.path);
        await ensureLocalParentDir(app, localPath.replace(/\/$/, "") + "/dummy");
      } else {
        const content = await provider.readFile(rule.cloudFolder, action.path);
        const localPath = toVaultPath(action.path);
        await ensureLocalParentDir(app, localPath);
        const mtime = action.sourceEntry?.mtime || Date.now();
        await app.vault.adapter.writeBinary(localPath, content, { mtime });
      }
      break;
    }
    case "local-delete": {
      // Local deleted → delete from cloud
      await provider.deleteFile(rule.cloudFolder, action.path.replace(/\/$/, ""));
      break;
    }
    case "cloud-delete": {
      // Cloud deleted → move local to trash
      const localPath = toVaultPath(action.path);
      const cleanPath = localPath.replace(/\/$/, "");
      const abstractFile = ctx.app.vault.getAbstractFileByPath(cleanPath);
      if (abstractFile) {
        await ctx.app.vault.trash(abstractFile, true);
      }
      break;
    }
  }
}

/** List local files under a vault folder, returning FileEntry[] with paths relative to that folder */
export async function listLocalFiles(
  app: App,
  localFolder: string
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  const files = app.vault.getFiles();
  const normalized = normalizePath(localFolder);
  const prefix = normalized ? normalized + "/" : "";

  for (const file of files) {
    const filePath = normalizePath(file.path);
    if (prefix && !filePath.startsWith(prefix)) continue;
    const relativePath = prefix ? filePath.substring(prefix.length) : filePath;
    if (!relativePath) continue;
    entries.push({
      path: relativePath,
      mtime: file.stat.mtime,
      size: file.stat.size,
      isFolder: false,
    });
  }

  // Also include folders
  const allFolders = app.vault.getAllFolders();
  for (const folder of allFolders) {
    const folderPath = normalizePath(folder.path);
    if (prefix && !folderPath.startsWith(prefix)) continue;
    const relativePath = prefix
      ? folderPath.substring(prefix.length)
      : folderPath;
    if (!relativePath) continue;
    entries.push({
      path: relativePath + "/",
      mtime: 0,
      size: 0,
      isFolder: true,
    });
  }

  return entries;
}

/** Ensure parent directories exist for a local file path */
async function ensureLocalParentDir(app: App, filePath: string): Promise<void> {
  const parts = normalizePath(filePath).split("/");
  parts.pop(); // remove filename
  if (parts.length === 0) return;
  const dirPath = parts.join("/");
  if (!(await app.vault.adapter.exists(dirPath))) {
    await app.vault.adapter.mkdir(dirPath);
  }
}

/** Fetch and cache file lists for a rule */
async function getOrFetchLists(
  rule: SyncRule,
  provider: ICloudProvider,
  ctx: PipelineContext,
  cache: Map<string, ListCache>
): Promise<ListCache> {
  if (cache.has(rule.id)) return cache.get(rule.id)!;

  ctx.onProgress?.(`[${rule.id}] Listing cloud files...`);
  const cloudList = await provider.listFiles(rule.cloudFolder);

  ctx.onProgress?.(`[${rule.id}] Listing local files...`);
  const localList = await listLocalFiles(ctx.app, rule.localFolder);

  const entry: ListCache = { cloudList, localList };
  cache.set(rule.id, entry);
  return entry;
}
