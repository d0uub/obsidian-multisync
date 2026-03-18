import type { App } from "obsidian";
import type {
  FileEntry,
  SyncAction,
  SyncStep,
  SyncRule,
  CloudAccount,
  Snapshot,
  MultiSyncSettings,
} from "../types";
import type { ICloudProvider } from "../providers/ICloudProvider";
import { OPERATION_DETECTORS } from "./operations";
import { buildMergedSnapshot } from "./snapshot";
import { normalizePath } from "../utils/helpers";

/**
 * SyncPipeline orchestrator.
 * Executes an ordered array of SyncStep (ruleId + operation).
 * Cloud + Operation = 2D matrix, user controls ordering.
 */

export interface PipelineContext {
  app: App;
  settings: MultiSyncSettings;
  providers: Map<string, ICloudProvider>; // accountId → provider
  /** Callback to persist updated settings (snapshots) */
  saveSettings: () => Promise<void>;
  /** Progress callback */
  onProgress?: (msg: string) => void;
  /** Called when an action is about to execute */
  onAction?: (action: SyncAction, step: SyncStep) => void;
  /** If true, only detect actions but don't execute them */
  dryRun?: boolean;
}

/** Cache for file lists so we don't re-fetch per operation */
interface ListCache {
  cloudList: FileEntry[];
  localList: FileEntry[];
}

/**
 * Run the full sync pipeline.
 * Each SyncStep is executed in order. Multiple operations on the same rule
 * share cached file lists (fetched once).
 */
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
      if (!rule) {
        errors.push(`Rule not found: ${step.ruleId}`);
        continue;
      }

      const account = ctx.settings.accounts.find((a) => a.id === rule.accountId);
      if (!account) {
        errors.push(`Account not found: ${rule.accountId}`);
        continue;
      }

      const provider = ctx.providers.get(account.id);
      if (!provider) {
        errors.push(`Provider not initialized for account: ${account.name}`);
        continue;
      }

      // Get or fetch file lists
      const cache = await getOrFetchLists(rule, provider, ctx, listCaches);
      const snapshot = ctx.settings.snapshots[rule.id] || {};

      // Detect actions for this operation
      const detector = OPERATION_DETECTORS[step.operation];
      if (!detector) {
        errors.push(`Unknown operation: ${step.operation}`);
        continue;
      }

      const actions = detector(cache.cloudList, cache.localList, snapshot);
      ctx.onProgress?.(
        `[${rule.id}] ${step.operation}: ${actions.length} action(s)`
      );

      // Execute actions
      for (const action of actions) {
        try {
          ctx.onAction?.(action, step);
          if (!ctx.dryRun) {
            await executeAction(action, rule, provider, ctx);
          }
          actionsExecuted++;
        } catch (e: any) {
          errors.push(
            `Failed ${action.operation} ${action.path}: ${e?.message || e}`
          );
        }
      }

      // Invalidate cache after write operations (add/update/delete modify file lists)
      if (actions.length > 0 && !ctx.dryRun) {
        listCaches.delete(rule.id);
      }
    } catch (e: any) {
      errors.push(
        `Step ${step.ruleId}/${step.operation} failed: ${e?.message || e}`
      );
    }
  }

  // After all steps complete, rebuild and save snapshots (skip in dry-run)
  if (!ctx.dryRun) {
    const touchedRuleIds = new Set(steps.map((s) => s.ruleId));
  for (const ruleId of touchedRuleIds) {
    try {
      const rule = ctx.settings.rules.find((r) => r.id === ruleId);
      if (!rule) continue;
      const account = ctx.settings.accounts.find((a) => a.id === rule.accountId);
      if (!account) continue;
      const provider = ctx.providers.get(account.id);
      if (!provider) continue;

      // Re-fetch fresh lists for snapshot
      const freshCloud = await provider.listFiles(rule.cloudFolder);
      const freshLocal = await listLocalFiles(ctx.app, rule.localFolder);
      ctx.settings.snapshots[ruleId] = buildMergedSnapshot(freshLocal, freshCloud);
    } catch (e: any) {
      errors.push(`Snapshot save failed for ${ruleId}: ${e?.message || e}`);
    }
    }

    await ctx.saveSettings();
  } // end dry-run guard

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
  const localBase = rule.localFolder;

  switch (action.operation) {
    case "local-update": {
      // Local file is newer → push to cloud
      const localPath = localBase ? `${localBase}/${action.path}` : action.path;
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
      const localPath = localBase ? `${localBase}/${action.path}` : action.path;
      await ensureLocalParentDir(app, localPath);
      await app.vault.adapter.writeBinary(localPath, content);
      break;
    }
    case "local-add": {
      if (action.isFolder) {
        await provider.mkdir(rule.cloudFolder, action.path.replace(/\/$/, ""));
      } else {
        const localPath = localBase ? `${localBase}/${action.path}` : action.path;
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
        const localPath = localBase ? `${localBase}/${action.path}` : action.path;
        await ensureLocalParentDir(app, localPath.replace(/\/$/, "") + "/dummy");
      } else {
        const content = await provider.readFile(rule.cloudFolder, action.path);
        const localPath = localBase ? `${localBase}/${action.path}` : action.path;
        await ensureLocalParentDir(app, localPath);
        await app.vault.adapter.writeBinary(localPath, content);
      }
      break;
    }
    case "local-delete": {
      // Local deleted → delete from cloud
      await provider.deleteFile(rule.cloudFolder, action.path.replace(/\/$/, ""));
      break;
    }
    case "cloud-delete": {
      // Cloud deleted → delete from local
      const localPath = localBase ? `${localBase}/${action.path}` : action.path;
      const cleanPath = localPath.replace(/\/$/, "");
      if (await app.vault.adapter.exists(cleanPath)) {
        await app.vault.adapter.remove(cleanPath);
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
  const prefix = localFolder ? normalizePath(localFolder) + "/" : "";

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
