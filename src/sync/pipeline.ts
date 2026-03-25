import { App, Modal } from "obsidian";
import type {
  FileEntry,
  SyncAction,
  SyncStep,
  SyncRule,
  CloudAccount,
  MultiSyncSettings,
} from "../types";
import type { ICloudProvider, DeltaChange } from "../providers/ICloudProvider";
import { PROVIDERS } from "../providers/registry";
import { OPERATION_DETECTORS } from "./operations";
import { normalizePath } from "../utils/helpers";
import { computeLocalHash } from "../utils/hashing";
import {
  saveCloudRegistry,
  loadCloudRegistry,
  applyDeltaChanges,
  buildIdToPathMap,
  type CloudFileEntry,
} from "../utils/cloudRegistry";
import { setSvgContent } from "../utils/helpers";

const OP_LABELS: Record<string, string> = {
  "local-add": "Add",
  "cloud-add": "Add",
  "local-update": "Update",
  "cloud-update": "Update",
  "local-delete": "Delete",
  "cloud-delete": "Delete",
};

/** ↑ = toward cloud, ↓ = toward local */
const OP_ARROW: Record<string, string> = {
  "local-add": "↑",
  "cloud-add": "↓",
  "local-update": "↑",
  "cloud-update": "↓",
  "local-delete": "↑",
  "cloud-delete": "↓",
};

/** Destination icon: ☁ = cloud, 📁 = local */
const OP_DEST: Record<string, string> = {
  "local-add": "☁",
  "cloud-add": "📁",
  "local-update": "☁",
  "cloud-update": "📁",
  "local-delete": "☁",
  "cloud-delete": "📁",
};

/**
 * SyncPipeline orchestrator.
 * Executes an ordered array of SyncStep (ruleId + operation).
 * Uses account-level delta sync with manifest-based delete detection.
 */

export interface SyncSummary {
  add: number;
  update: number;
  delete: number;
  total: number;
  details: { operation: string; count: number; paths: string[]; accountName: string; accountType: string; localFolder: string; cloudFolder: string }[];
}

export interface PipelineContext {
  app: App;
  settings: MultiSyncSettings;
  providers: Map<string, ICloudProvider>;
  /** Callback to persist settings */
  saveSettings: () => Promise<void>;
  onProgress?: (msg: string) => void;
  onAction?: (action: SyncAction, step: SyncStep) => void;
  /** Called with action summary before execution. Return false to cancel. */
  onSummary?: (summary: SyncSummary) => Promise<boolean>;
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

  // ── 1. Delta sync per account ──────────────────────────────────
  const accountRegistries = new Map<string, CloudFileEntry[]>();
  const accountBases = new Map<string, CloudFileEntry[]>();
  const accountDeltas = new Map<string, DeltaChange[]>();
  const processedAccounts = new Set<string>();
  // Deferred delta tokens — saved only after execution completes
  const pendingDeltaTokens = new Map<string, string>();

  for (const step of steps) {
    const rule = ctx.settings.rules.find((r) => r.id === step.ruleId);
    if (!rule) continue;
    const account = ctx.settings.accounts.find((a) => a.id === rule.accountId);
    if (!account || processedAccounts.has(account.id)) continue;
    processedAccounts.add(account.id);
    const provider = ctx.providers.get(account.id);
    if (!provider) continue;

    try {
      const base = await loadCloudRegistry(account.id);
      accountBases.set(account.id, base);

      const driveKey = "me"; // future: resolve from SyncRule.driveId for shared folders
      const existingToken = account.deltaTokens?.[driveKey] || "";

      // Collect all cloud folder prefixes mapped to this account
      const mappedRules = ctx.settings.rules.filter(r => r.accountId === account.id);
      const mappedPrefixes = mappedRules.map(r => folderPrefix(r.cloudFolder));

      let registry: CloudFileEntry[];
      let deltas: DeltaChange[];

      if (!existingToken) {
        // First sync: use listFiles per mapped folder (fast, scoped) + get baseline token
        const entries: CloudFileEntry[] = [];
        for (const r of mappedRules) {
          const pfx = folderPrefix(r.cloudFolder);
          const files = await provider.listFiles(r.cloudFolder);
          for (const f of files) {
            entries.push({
              id: f.cloudId || f.path,
              path: pfx ? `${pfx}/${f.path}` : f.path,
              mtime: f.mtime,
              size: f.size,
              isFolder: f.isFolder,
              hash: f.hash,
              ctime: f.ctime,
            });
          }
        }
        if (!ctx.dryRun) {
          await saveCloudRegistry(account.id, entries, provider.unsyncableFiles || []);
          const baselineToken = await provider.getBaselineDeltaToken();
          pendingDeltaTokens.set(`${account.id}:${driveKey}`, baselineToken);
        }
        registry = entries;
        deltas = []; // no deltas on first sync — registry IS the full state
      } else {
        // Incremental sync: use delta API (small payload)
        const result = await provider.syncAccountDelta(existingToken);

        // Resolve missing paths on deleted entries (OneDrive omits name for deletes)
        if (base.length > 0) {
          const idToPath = buildIdToPathMap(base);
          for (const c of result.changes) {
            if (c.deleted && !c.path && c.id) c.path = idToPath[c.id];
          }
        }

        // Filter changes to only include paths under mapped folders
        const filtered = result.changes.filter(c => {
          if (!c.path) return c.deleted; // keep unresolved deletes for safety
          return mappedPrefixes.some(pfx => !pfx || c.path!.startsWith(pfx + "/") || c.path === pfx);
        });

        if (!ctx.dryRun) {
          registry = await applyDeltaChanges(account.id, filtered, result.isFullEnum);
          pendingDeltaTokens.set(`${account.id}:${driveKey}`, result.newDeltaToken);
        } else {
          // Dry run: compute registry in-memory without persisting
          registry = base;
        }
        deltas = filtered;
      }

      accountRegistries.set(account.id, registry);
      accountDeltas.set(account.id, deltas);
      console.debug(`[Sync][Delta] ${account.name}: token=${existingToken ? "incremental" : "first-sync"}, registry=${registry.length} entries, deltas=${deltas.length} changes, base=${base.length} entries`);
    } catch (e: any) {
      errors.push(`Failed to sync delta for ${account.name}: ${e?.message || e}`);
    }
  }

  // ── 2. Detection phase — collect all actions before executing ──
  const stepActions = new Map<number, { step: SyncStep; rule: SyncRule; account: CloudAccount; provider: ICloudProvider; actions: SyncAction[] }>();

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    try {
      const rule = ctx.settings.rules.find((r) => r.id === step.ruleId);
      if (!rule) { errors.push(`Rule not found: ${step.ruleId}`); continue; }

      const account = ctx.settings.accounts.find((a) => a.id === rule.accountId);
      if (!account) { errors.push(`Account not found: ${rule.accountId}`); continue; }

      const provider = ctx.providers.get(account.id);
      if (!provider) { errors.push(`Provider not initialized for account: ${account.name}`); continue; }

      const cache = await getOrFetchLists(rule, provider, ctx, listCaches, accountRegistries, account);

      const detector = OPERATION_DETECTORS[step.operation];
      if (!detector) { errors.push(`Unknown operation: ${step.operation}`); continue; }

      const cloudDeletedPaths = getDeletedPathsForRule(accountDeltas.get(account.id) || [], rule.cloudFolder);
      const basePaths = buildBaseForRule(accountBases.get(account.id) || [], rule.cloudFolder);

      let actions = detector(cache.cloudList, cache.localList, cloudDeletedPaths, basePaths);

      if (step.operation === "local-delete" || step.operation === "cloud-delete") actions = pruneRedundantDeletes(actions);

      // For update operations: verify with hash when sizes match (avoids false updates from mtime rounding)
      if ((step.operation === "local-update" || step.operation === "cloud-update") && actions.length > 0) {
        const verified: typeof actions = [];
        const normalBase = normalizePath(rule.localFolder);
        for (const a of actions) {
          if (a.isFolder) { verified.push(a); continue; }
          const cloudEntry = cache.cloudList.find(c => c.path.toLowerCase() === a.path.toLowerCase());
          if (cloudEntry?.hash && a.sourceEntry?.size === cloudEntry.size) {
            // Same size: compute local hash to confirm content difference
            const vaultPath = normalBase ? `${normalBase}/${a.path}` : a.path;
            try {
              const content = await ctx.app.vault.adapter.readBinary(vaultPath);
              const localHash = await computeLocalHash(account.type as any, content);
              if (localHash === cloudEntry.hash) {
                continue; // Hash match — skip this false update
              }
            } catch { /* file read failed, keep the action */ }
          }
          verified.push(a);
        }
        if (actions.length !== verified.length) {
          console.debug(`[Sync][HashVerify] ${step.operation}: skipped ${actions.length - verified.length} false updates (hash match)`);
        }
        actions = verified;
      }

      // Filter out files exceeding the max file size setting
      const maxBytes = (ctx.settings.maxFileSizeMB || 200) * 1e6;
      const beforeCount = actions.length;
      actions = actions.filter(a => {
        if (a.isFolder) return true; // folders always pass
        const size = a.sourceEntry?.size || 0;
        return size <= maxBytes;
      });
      if (actions.length < beforeCount) {
        console.debug(`[Sync][SizeFilter] ${step.operation}: skipped ${beforeCount - actions.length} files exceeding ${ctx.settings.maxFileSizeMB || 200} MB`);
      }

      // Diagnostic logging for troubleshooting false-positive detections
      if (actions.length > 0) {
        console.debug(`[Sync][Detect] ${step.operation} for ${account.name}: ${actions.length} actions, cloudList=${cache.cloudList.length}, localList=${cache.localList.length}, basePaths=${basePaths?.size ?? "null"}, deltas=${cloudDeletedPaths.length}`);
        for (const a of actions.slice(0, 5)) {
          const cloudEntry = cache.cloudList.find(c => c.path === a.path);
          const localEntry = cache.localList.find(l => l.path === a.path);
          console.debug(`  ${a.operation} "${a.path}" | cloud: mtime=${cloudEntry?.mtime} size=${cloudEntry?.size} hash=${cloudEntry?.hash?.slice(0,8)} | local: mtime=${localEntry?.mtime} size=${localEntry?.size} | source: mtime=${a.sourceEntry?.mtime} size=${a.sourceEntry?.size}`);
        }
        if (actions.length > 5) console.debug(`  ... and ${actions.length - 5} more`);
      }

      ctx.onProgress?.(`${actions.length} action(s) for ${step.operation}`);

      if (actions.length > 0) {
        stepActions.set(si, { step, rule, account, provider, actions });
      }
    } catch (e: any) {
      errors.push(`${OP_LABELS[step.operation] || step.operation}: ${e?.message || e}`);
    }
  }

  // ── 3. Summary confirmation — show user what will happen ──
  if (ctx.onSummary && !ctx.dryRun) {
    let addCount = 0, updateCount = 0, deleteCount = 0;
    const details: SyncSummary["details"] = [];
    for (const { step, account, rule, actions } of stepActions.values()) {
      const paths = actions.slice(0, 100).map(a => a.path);
      if (step.operation.includes("add")) addCount += actions.length;
      else if (step.operation.includes("update")) updateCount += actions.length;
      else if (step.operation.includes("delete")) deleteCount += actions.length;
      details.push({ operation: step.operation, count: actions.length, paths, accountName: account.name, accountType: account.type || "", localFolder: rule.localFolder, cloudFolder: rule.cloudFolder });
    }
    const total = addCount + updateCount + deleteCount;
    if (total > 0) {
      const confirmed = await ctx.onSummary({ add: addCount, update: updateCount, delete: deleteCount, total, details });
      if (!confirmed) {
        // Rollback ALL processed accounts to their pre-Phase-1 state
        for (const [accountId, base] of accountBases) {
          console.debug(`[Sync][Rollback] ${accountId}: restoring ${base.length} entries`);
          await saveCloudRegistry(accountId, base);
        }
        console.debug("[Sync] User cancelled from summary — registry rolled back to pre-sync state");
        return { actionsExecuted: 0, errors: [] };
      }
    }
  }

  // ── 4. Execution phase — run detected actions ──
  for (const [, { step, rule, account, provider, actions }] of stepActions.entries()) {
    try {
      // Sort: small files first (concurrent), large files last (serialized to avoid OOM)
      const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50 MB
      const smallActions = actions.filter(a => a.isFolder || !a.sourceEntry || a.sourceEntry.size <= LARGE_FILE_THRESHOLD);
      const largeActions = actions.filter(a => !a.isFolder && a.sourceEntry && a.sourceEntry.size > LARGE_FILE_THRESHOLD);

      const concurrency = ctx.settings.concurrency || 4;
      let pendingSaves = 0;
      let stepExecuted = 0;

      // Process small files concurrently
      let i = 0;
      const runNext = async (): Promise<void> => {
        while (i < smallActions.length) {
          const action = smallActions[i++];
          try {
            const arrow = OP_ARROW[action.operation] || "";
            const opLabel = OP_LABELS[action.operation] || action.operation;
            const providerLabel = { dropbox: "Dropbox", onedrive: "OneDrive", gdrive: "GDrive" }[account.type || ""] || "";
            ctx.onAction?.(action, step);
            const dest = OP_DEST[action.operation] || "";
            const toCloud = ["local-add", "local-update", "local-delete"].includes(action.operation);
            const destPath = toCloud ? `${rule.cloudFolder}/${action.path}` : `${rule.localFolder}/${action.path}`;
            console.debug(`${arrow} ${account.name}${providerLabel ? ` (${providerLabel})` : ""} ${opLabel}: ${dest} ${destPath}`);
            if (!ctx.dryRun) {
              const executed = await executeAction(action, rule, provider, ctx);
              if (!executed) continue; // hash match — skipped
              stepExecuted++;
              pendingSaves++;
              if (pendingSaves >= 20) {
                pendingSaves = 0;
                await ctx.saveSettings();
              }
            }
            actionsExecuted++;
            // Yield to event loop for GC between file operations
            if (actionsExecuted % 5 === 0) await new Promise(r => setTimeout(r, 0));
          } catch (e: any) {
            const detail = e?.status ? `status ${e.status}` : (e?.message || e);
            const errLabel = OP_LABELS[action.operation] || action.operation;
            const errArrow = OP_ARROW[action.operation] || "";
            errors.push(`${errLabel} ${action.path}: ${detail}`);
            console.error(`${errArrow} ERROR ${errLabel}: ${action.path} — ${detail}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, smallActions.length) }, () => runNext()));

      // Process large files one at a time to avoid OOM from concurrent memory pressure
      for (const action of largeActions) {
        try {
          const arrow = OP_ARROW[action.operation] || "";
          const opLabel = OP_LABELS[action.operation] || action.operation;
          ctx.onAction?.(action, step);
          const dest = OP_DEST[action.operation] || "";
          const toCloud = ["local-add", "local-update", "local-delete"].includes(action.operation);
          const destPath = toCloud ? `${rule.cloudFolder}/${action.path}` : `${rule.localFolder}/${action.path}`;
          const sizeMB = ((action.sourceEntry?.size || 0) / 1e6).toFixed(0);
          console.debug(`${arrow} ${account.name} ${opLabel}: ${dest} ${destPath} (${sizeMB} MB, sequential)`);
          if (!ctx.dryRun) {
            const executed = await executeAction(action, rule, provider, ctx);
            if (!executed) continue;
            stepExecuted++;
            pendingSaves++;
            if (pendingSaves >= 20) { pendingSaves = 0; await ctx.saveSettings(); }
          }
          actionsExecuted++;
          // Force yield after large file for GC
          await new Promise(r => setTimeout(r, 0));
        } catch (e: any) {
          const detail = e?.status ? `status ${e.status}` : (e?.message || e);
          errors.push(`${OP_LABELS[action.operation] || action.operation} ${action.path}: ${detail}`);
          console.error(`ERROR ${action.path} — ${detail}`);
        }
      }

      if (pendingSaves > 0 && !ctx.dryRun) {
        await ctx.saveSettings();
      }

      if (stepExecuted > 0 && !ctx.dryRun) {
        if (step.operation === "cloud-delete") await cleanupEmptyFolders(ctx.app, rule.localFolder);
        const cached = listCaches.get(rule.id);
        if (cached) {
          if (["cloud-add", "cloud-update", "cloud-delete"].includes(step.operation)) {
            cached.localList = listLocalFiles(ctx.app, rule.localFolder);
          } else {
            cached.cloudList = await provider.listFiles(rule.cloudFolder);
            updateAccountRegistryFromCloudList(accountRegistries, account.id, rule.cloudFolder, cached.cloudList);
          }
        }
      }
    } catch (e: any) {
      errors.push(`${OP_LABELS[step.operation] || step.operation}: ${e?.message || e}`);
    }
  }

  if (!ctx.dryRun) {
    // Reconcile registry mtimes with local mtimes to prevent false-positive updates
    // (handles cloud mtime drift from services like Google AI Studio)
    for (const [ruleId, cache] of listCaches.entries()) {
      const rule = ctx.settings.rules.find(r => r.id === ruleId);
      if (!rule) continue;
      const reg = accountRegistries.get(rule.accountId);
      if (!reg?.length) continue;
      const localMap = new Map<string, FileEntry>();
      for (const e of cache.localList) localMap.set(e.path, e);
      const pfx = folderPrefix(rule.cloudFolder);
      for (const entry of reg) {
        const rel = stripPrefix(entry.path, pfx);
        if (!rel) continue;
        const local = localMap.get(rel);
        if (local && local.size === entry.size && entry.hash) {
          // Same size + cloud has hash → sync mtime to local (content verified equal by hash check)
          entry.mtime = local.mtime;
        }
      }
    }

    const saved = new Set<string>();
    for (const s of steps) {
      const rule = ctx.settings.rules.find(r => r.id === s.ruleId);
      if (rule && !saved.has(rule.accountId)) {
        saved.add(rule.accountId);
        const reg = accountRegistries.get(rule.accountId);
        const provider = ctx.providers.get(rule.accountId);
        if (reg?.length) await saveCloudRegistry(rule.accountId, reg, provider?.unsyncableFiles || []);
      }
    }

    // Generate/update/remove "Unsupported Files Detected.md" marker files for GDrive accounts
    // (Removed — ghost files now provide visibility for unsyncable files)

    // Commit deferred delta tokens — only after all execution and registry saves complete
    for (const [key, token] of pendingDeltaTokens) {
      const [accountId, driveKey] = key.split(":");
      const account = ctx.settings.accounts.find(a => a.id === accountId);
      if (account) {
        if (!account.deltaTokens) account.deltaTokens = {};
        account.deltaTokens[driveKey] = token;
      }
    }
    if (pendingDeltaTokens.size > 0) await ctx.saveSettings();
  }

  return { actionsExecuted, errors };
}

/** Modal showing a full sync summary before execution. User can confirm or cancel. */
/** User-friendly operation labels for the summary modal */
const SUMMARY_LABELS: Record<string, string> = {
  "local-add": "Upload",
  "cloud-add": "Download",
  "local-update": "Upload changes",
  "cloud-update": "Download changes",
  "local-delete": "Remove from cloud",
  "cloud-delete": "Remove from local",
};

export class SyncSummaryModal extends Modal {
  private confirmed = false;
  private resolve: ((v: boolean) => void) | null = null;
  constructor(app: App, private summary: SyncSummary) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    const s = this.summary;

    contentEl.createEl("h3", { text: `Sync summary — ${s.total} action(s)` });

    // Counts row: ➕ Add  ↻ Update  🗑 Delete
    const counts = contentEl.createEl("div", { cls: "multisync-summary-counts" });
    if (s.add > 0) counts.createEl("span", { text: `➕ Add: ${s.add}` });
    if (s.update > 0) counts.createEl("span", { text: `↻ Update: ${s.update}` });
    if (s.delete > 0) {
      counts.createEl("span", { text: `🗑 Delete: ${s.delete}`, cls: "multisync-summary-delete" });
    }

    // Per-operation expandable details: ↑ <icon> (driveName) Upload: ☁ N file(s)
    for (const d of s.details) {
      if (d.count === 0) continue;
      const details = contentEl.createEl("details");
      const friendlyOp = SUMMARY_LABELS[d.operation] || d.operation;
      const arrow = OP_ARROW[d.operation] || "";
      const dest = OP_DEST[d.operation] || "";

      const summaryEl = details.createEl("summary", { cls: "multisync-summary-detail-header" });
      summaryEl.createSpan({ text: arrow });
      // Inline provider SVG icon
      const svgIcon = PROVIDERS[d.accountType as keyof typeof PROVIDERS]?.svgIcon;
      if (svgIcon) {
        const iconSpan = summaryEl.createSpan({ cls: "multisync-summary-icon" });
        setSvgContent(iconSpan, svgIcon);
      }
      const toCloud = ["local-add", "local-update", "local-delete"].includes(d.operation);
      summaryEl.createSpan({ text: `(${d.accountName}) ${friendlyOp}: ${dest} ${d.count} file(s)` });
      const list = details.createEl("div", { cls: "multisync-summary-file-list" });
      const maxShow = 50;
      const shown = d.paths.slice(0, maxShow);
      // Show full path with folder prefix
      const pathPrefix = toCloud ? d.localFolder : d.cloudFolder;
      for (const p of shown) {
        const fullPath = pathPrefix ? `${pathPrefix}/${p}` : p;
        list.createEl("div", { text: fullPath });
      }
      if (d.paths.length > maxShow) {
        list.createEl("div", { text: `… and ${d.paths.length - maxShow} more`, cls: "multisync-summary-more" });
      }
    }

    // Buttons
    const btnRow = contentEl.createEl("div", { cls: "multisync-modal-btn-row-gap" });

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => { this.confirmed = false; this.close(); };

    const cls = s.delete > 0 ? "mod-warning" : "mod-cta";
    const confirmBtn = btnRow.createEl("button", { text: "Confirm sync", cls });
    confirmBtn.onclick = () => { this.confirmed = true; this.close(); };
  }

  onClose() {
    this.contentEl.empty();
    this.resolve?.(this.confirmed);
  }

  awaitResult(): Promise<boolean> {
    return new Promise<boolean>((resolve) => { this.resolve = resolve; });
  }
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
      // Size guard: skip if read size doesn't match expected (file may be mid-write by another process)
      if (action.sourceEntry?.size && Math.abs(content.byteLength - action.sourceEntry.size) > 1) {
        console.warn(`[Sync] Size mismatch for ${action.path}: read ${content.byteLength} bytes, expected ${action.sourceEntry.size} — skipping (file may be mid-write)`);
        return false;
      }
      // Hash check: skip upload if content matches cloud
      if (action.cloudHash) {
        const localHash = await computeLocalHash(provider.kind, content);
        if (localHash && localHash === action.cloudHash) {
          ctx.onProgress?.(`Skip ${action.path} (unchanged)`);
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
            ctx.onProgress?.(`Skip ${action.path} (unchanged)`);
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
      // Post-write verification: ensure written file size matches downloaded content
      try {
        const stat = await app.vault.adapter.stat(localPathUpd);
        if (stat && stat.size !== content.byteLength) {
          console.error(`[Sync] Post-write size mismatch for ${action.path}: wrote ${content.byteLength}, on disk ${stat.size} — file may be corrupt`);
        }
      } catch { /* stat failure is non-fatal */ }
      break;
    }
    case "local-add": {
      if (action.isFolder) {
        await provider.mkdir(rule.cloudFolder, action.path.replace(/\/$/, ""));
      } else {
        const localPath = toVaultPath(action.path);
        const content = await app.vault.adapter.readBinary(localPath);
        // Size guard: skip if file changed since detection (mid-write by another process)
        if (action.sourceEntry?.size && Math.abs(content.byteLength - action.sourceEntry.size) > 1) {
          console.warn(`[Sync] Size mismatch for ${action.path}: read ${content.byteLength} bytes, expected ${action.sourceEntry.size} — skipping (file may be mid-write)`);
          return false;
        }
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
        // Post-write verification
        try {
          const stat = await app.vault.adapter.stat(localPath);
          if (stat && stat.size !== content.byteLength) {
            console.error(`[Sync] Post-write size mismatch for ${action.path}: wrote ${content.byteLength}, on disk ${stat.size} — file may be corrupt`);
          }
        } catch { /* stat failure is non-fatal */ }
      }
      break;
    }
    case "local-delete": {
      // Local deleted → delete from cloud (soft-delete / trash)
      const deleteCloudId = action.sourceEntry?.cloudId;
      if (action.isFolder) {
        // Delete folder from cloud directly (no backup for folders)
        await provider.deleteFile(rule.cloudFolder, action.path.replace(/\/$/, ""), deleteCloudId);
        break;
      }

      if (ctx.settings.backupBeforeCloudDelete) {
        // Check if file already exists in Obsidian .trash — skip backup if so
        const backupPath = toVaultPath(action.path);
        const trashPath = `.trash/${backupPath}`;
        const alreadyInTrash = await app.vault.adapter.exists(trashPath);
        if (!alreadyInTrash) {
          try {
            const content = await provider.readFile(rule.cloudFolder, action.path);
            await ensureLocalParentDir(app, backupPath);
            await app.vault.adapter.writeBinary(backupPath, content);
            const abstractFile = app.vault.getAbstractFileByPath(backupPath);
            if (abstractFile) await app.fileManager.trashFile(abstractFile);
          } catch (backupErr: any) {
            console.warn(`Skipping cloud delete for ${action.path}: backup failed — ${backupErr?.message || backupErr}`);
            break;
          }
        }
      }

      await provider.deleteFile(rule.cloudFolder, action.path.replace(/\/$/, ""), deleteCloudId);
      break;
    }
    case "cloud-delete": {
      // Cloud deleted → move local to trash
      const localPath = toVaultPath(action.path);
      const cleanPath = localPath.replace(/\/$/, "");
      const abstractFile = ctx.app.vault.getAbstractFileByPath(cleanPath);
      if (abstractFile) {
        try {
          await ctx.app.fileManager.trashFile(abstractFile);
        } catch (e: any) {
          if (e?.message?.includes("ENOENT")) break; // already gone
          throw e;
        }
      }
      break;
    }
  }
  return true;
}

/** List local files under a vault folder, returning FileEntry[] with paths relative to that folder */
export function listLocalFiles(
  app: App,
  localFolder: string
): FileEntry[] {
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

/** Fetch and cache file lists for a rule.
 *  Cloud list is derived from the account registry (filtered by cloudFolder).
 *  Falls back to provider.listFiles() if registry is empty. */
async function getOrFetchLists(
  rule: SyncRule,
  provider: ICloudProvider,
  ctx: PipelineContext,
  cache: Map<string, ListCache>,
  accountRegistries: Map<string, CloudFileEntry[]>,
  account: CloudAccount
): Promise<ListCache> {
  if (cache.has(rule.id)) return cache.get(rule.id)!;

  const localList = listLocalFiles(ctx.app, rule.localFolder);

  const registry = accountRegistries.get(account.id);
  const cloudList = registry?.length
    ? filterRegistryByFolder(registry, rule.cloudFolder)
    : await provider.listFiles(rule.cloudFolder);

  const entry: ListCache = { cloudList, localList };
  cache.set(rule.id, entry);
  return entry;
}

/** Normalize cloud folder to a prefix string (no leading slash, no trailing slash). */
function folderPrefix(cloudFolder: string): string {
  if (!cloudFolder || cloudFolder === "/") return "";
  return cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder;
}

/** Strip folder prefix from a full path, returning the relative portion. Returns "" if no match. */
function stripPrefix(fullPath: string, prefix: string): string {
  if (!prefix) return fullPath;
  const withSlash = prefix + "/";
  return fullPath.startsWith(withSlash) ? fullPath.substring(withSlash.length) : "";
}

/** Filter account registry to a specific cloud folder, returning FileEntry[] with relative paths. */
function filterRegistryByFolder(registry: CloudFileEntry[], cloudFolder: string): FileEntry[] {
  const pfx = folderPrefix(cloudFolder);
  // Collect entries with relative paths
  const raw: { rel: string; entry: CloudFileEntry }[] = [];
  for (const e of registry) {
    const rel = stripPrefix(e.path, pfx);
    if (!rel) continue;
    // Skip hidden files/folders (any path segment starting with '.')
    if (rel.split("/").some(s => s.startsWith("."))) continue;
    raw.push({ rel, entry: e });
  }
  // Sort by (path, mtime desc) for consistent disambiguation with listFiles
  raw.sort((a, b) => {
    const cmp = a.rel.localeCompare(b.rel);
    if (cmp !== 0) return cmp;
    return b.entry.mtime - a.entry.mtime;
  });
  // Disambiguate duplicate paths: photo.jpg → photo (1).jpg, photo (2).jpg
  const pathCount = new Map<string, number>();
  const entries: FileEntry[] = [];
  for (const { rel, entry: e } of raw) {
    let path = rel;
    if (!e.isFolder) {
      const key = path.toLowerCase();
      const count = pathCount.get(key) || 0;
      pathCount.set(key, count + 1);
      if (count > 0) {
        const dotIdx = path.lastIndexOf(".");
        if (dotIdx > 0) {
          path = `${path.substring(0, dotIdx)} (${count})${path.substring(dotIdx)}`;
        } else {
          path = `${path} (${count})`;
        }
      }
    }
    entries.push({ path, mtime: e.mtime, size: e.size, isFolder: e.isFolder, hash: e.hash, ctime: e.ctime, cloudId: e.id });
  }
  return entries;
}

/** Extract deleted-file paths (relative) for a rule's cloud folder from delta changes. */
function getDeletedPathsForRule(changes: DeltaChange[], cloudFolder: string): string[] {
  const pfx = folderPrefix(cloudFolder);
  const deleted: string[] = [];
  for (const c of changes) {
    if (!c.deleted || !c.path) continue;
    const rel = stripPrefix(c.path, pfx);
    if (rel) deleted.push(rel);
  }
  return deleted;
}

/** Build 3-way sync base: Set of relative paths from the pre-delta registry for this cloud folder. */
function buildBaseForRule(registry: CloudFileEntry[], cloudFolder: string): Set<string> | null {
  if (registry.length === 0) return null;
  // Use filterRegistryByFolder to get disambiguated paths (consistent with cloudList)
  const entries = filterRegistryByFolder(registry, cloudFolder);
  if (entries.length === 0) return null;
  const paths = new Set<string>();
  for (const e of entries) paths.add(e.path.toLowerCase()); // case-insensitive for Dropbox/OneDrive
  return paths;
}

/** Replace entries under a cloud folder in the in-memory account registry after re-listing. */
function updateAccountRegistryFromCloudList(
  accountRegistries: Map<string, CloudFileEntry[]>,
  accountId: string,
  cloudFolder: string,
  cloudList: FileEntry[]
): void {
  const registry = accountRegistries.get(accountId);
  if (!registry) return;
  const pfx = folderPrefix(cloudFolder);
  const withSlash = pfx ? pfx + "/" : "";
  const kept = pfx ? registry.filter(e => !e.path.startsWith(withSlash)) : [];
  for (const e of cloudList) {
    const fullPath = pfx ? `${pfx}/${e.path}` : e.path;
    kept.push({ id: e.cloudId || fullPath, path: fullPath, mtime: e.mtime, size: e.size, isFolder: e.isFolder, hash: e.hash, ctime: e.ctime });
  }
  accountRegistries.set(accountId, kept);
}

/** After cloud-delete removes files, trash any sub-folders that are now empty.
 *  Walks deepest-first so nested empty folders are cleaned bottom-up. */
async function cleanupEmptyFolders(app: App, localFolder: string): Promise<void> {
  const normalized = normalizePath(localFolder);
  const allFolders = app.vault.getAllFolders()
    .filter(f => {
      const fp = normalizePath(f.path);
      return normalized ? fp.startsWith(normalized + "/") : fp.length > 0;
    })
    .sort((a, b) => b.path.length - a.path.length); // deepest first

  for (const folder of allFolders) {
    const listed = await app.vault.adapter.list(folder.path);
    if ((listed.files || []).length === 0 && (listed.folders || []).length === 0) {
      try {
        await app.fileManager.trashFile(folder);
      } catch { /* best effort */ }
    }
  }
}

/** Remove delete actions for files/folders whose parent folder is also being deleted.
 *  Deleting a folder recursively removes all children, so individual child deletes are redundant. */
function pruneRedundantDeletes(actions: SyncAction[]): SyncAction[] {
  // Collect folder paths being deleted (without trailing slash for prefix matching)
  const deletedFolders = new Set<string>();
  for (const a of actions) {
    if (a.isFolder) {
      deletedFolders.add(a.path.replace(/\/$/, "") + "/");
    }
  }
  if (deletedFolders.size === 0) return actions;

  return actions.filter(a => {
    // Keep folder deletes, but check if a parent folder is also being deleted
    for (const folder of deletedFolders) {
      if (a.path !== folder && a.path.startsWith(folder)) return false;
      // Also check for nested folder deletes: "sub/" inside "parent/sub/"
      const cleanPath = a.isFolder ? a.path.replace(/\/$/, "") + "/" : a.path;
      if (cleanPath !== folder && cleanPath.startsWith(folder)) return false;
    }
    return true;
  });
}

/** Create/update/remove native file marker MDs for GDrive rules after sync */
/* Native file markers removed — ghost files now handle unsyncable file visibility */
