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
import { computeLocalHash } from "../utils/hashing";

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
      let stepExecuted = 0;
      let i = 0;
      const runNext = async (): Promise<void> => {
        while (i < actions.length) {
          const action = actions[i++];
          try {
            ctx.onAction?.(action, step);
            if (!ctx.dryRun) {
              const executed = await executeAction(action, rule, provider, ctx);
              if (!executed) continue; // hash match — skipped
              stepExecuted++;
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
            const detail = e?.status ? `status ${e.status}` : (e?.message || e);
            errors.push(`Failed ${action.operation} ${action.path}: ${detail}`);
            console.error("MultiSync action error:", action.operation, action.path, e);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, actions.length) }, () => runNext()));
      if (pendingSaves > 0 && !ctx.dryRun) {
        await ctx.saveSettings();
      }

      // Partial cache invalidation: only re-list what actually changed
      if (stepExecuted > 0 && !ctx.dryRun) {
        const cached = listCaches.get(rule.id);
        if (cached) {
          if (step.operation === "cloud-add" || step.operation === "cloud-update" || step.operation === "cloud-delete") {
            // Only local changed → re-fetch local list, keep cloud list
            cached.localList = await listLocalFiles(ctx.app, rule.localFolder);
          } else {
            // local-add, local-update, local-delete → cloud changed → re-fetch cloud list, keep local
            cached.cloudList = await provider.listFiles(rule.cloudFolder);
          }
        }
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

/** Execute a single sync action. Returns true if actually executed, false if skipped (hash match). */
async function executeAction(
  action: SyncAction,
  rule: SyncRule,
  provider: ICloudProvider,
  ctx: PipelineContext
): Promise<boolean> {
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
      // Hash check: skip upload if content matches cloud
      if (action.cloudHash) {
        const localHash = await computeLocalHash(provider.kind, content);
        if (localHash && localHash === action.cloudHash) {
          ctx.onProgress?.(`[skip] ${action.path} (hash match)`);
          // Align local mtime to cloud's so next sync sees them as equal
          if (action.cloudMtime) {
            try { await app.vault.adapter.writeBinary(localPath, content, { mtime: action.cloudMtime }); } catch { /* best effort */ }
          }
          return false;
        }
      }
      await provider.writeFile(
        rule.cloudFolder,
        action.path,
        content,
        action.sourceEntry?.mtime || Date.now(),
        action.sourceEntry?.ctime
      );
      break;
    }
    case "cloud-update": {
      // Cloud file is newer → pull to local
      // Hash check: read local file first, compare hash to skip download
      const localPathUpd = toVaultPath(action.path);
      if (action.sourceEntry?.hash) {
        try {
          const localContent = await app.vault.adapter.readBinary(localPathUpd);
          const localHash = await computeLocalHash(provider.kind, localContent);
          if (localHash && localHash === action.sourceEntry.hash) {
            ctx.onProgress?.(`[skip] ${action.path} (hash match)`);
            // Align local mtime to cloud so next sync sees them as equal
            const cloudMtime = action.sourceEntry.mtime;
            if (cloudMtime) {
              try { await app.vault.adapter.writeBinary(localPathUpd, localContent, { mtime: cloudMtime }); } catch { /* best effort */ }
            }
            return false;
          }
        } catch { /* file may not exist yet, proceed with download */ }
      }
      const content = await provider.readFile(rule.cloudFolder, action.path);
      await ensureLocalParentDir(app, localPathUpd);
      const mtime = action.sourceEntry?.mtime || Date.now();
      const ctime = action.sourceEntry?.ctime;
      await app.vault.adapter.writeBinary(localPathUpd, content, { mtime, ...(ctime ? { ctime } : {}) });
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
          action.sourceEntry?.mtime || Date.now(),
          action.sourceEntry?.ctime
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
        const ctime = action.sourceEntry?.ctime;
        await app.vault.adapter.writeBinary(localPath, content, { mtime, ...(ctime ? { ctime } : {}) });
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
  return true;
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
      ctime: file.stat.ctime,
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
  ctx.onProgress?.(`[${rule.id}] Cloud: ${cloudList.length} items`);

  ctx.onProgress?.(`[${rule.id}] Listing local files...`);
  const localList = await listLocalFiles(ctx.app, rule.localFolder);
  ctx.onProgress?.(`[${rule.id}] Local: ${localList.length} items`);

  const entry: ListCache = { cloudList, localList };
  cache.set(rule.id, entry);
  return entry;
}
