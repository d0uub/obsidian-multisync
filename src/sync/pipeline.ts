import { App, Modal } from "obsidian";
import type {
  FileEntry,
  SyncAction,
  SyncStep,
  SyncRule,
  CloudAccount,
  MultiSyncSettings,
} from "../types";
import type { ICloudProvider } from "../providers/ICloudProvider";
import { PROVIDERS } from "../providers/registry";
import { OPERATION_DETECTORS } from "./operations";
import { normalizePath } from "../utils/helpers";
import { computeLocalHash } from "../utils/hashing";
import {
  saveCloudRegistry,
  loadCloudRegistry,
  type CloudFileEntry,
} from "../utils/cloudRegistry";
import { setSvgContent } from "../utils/helpers";

const OP_LABELS: Record<string, string> = {
  "local-add": "Add", "cloud-add": "Add",
  "local-update": "Update", "cloud-update": "Update",
  "local-delete": "Delete", "cloud-delete": "Delete",
};
const OP_ARROW: Record<string, string> = {
  "local-add": "↑", "cloud-add": "↓",
  "local-update": "↑", "cloud-update": "↓",
  "local-delete": "↑", "cloud-delete": "↓",
};
const OP_DEST: Record<string, string> = {
  "local-add": "☁", "cloud-add": "📁",
  "local-update": "☁", "cloud-update": "📁",
  "local-delete": "☁", "cloud-delete": "📁",
};

/* ──────────────────────────────────────────────────
 * SyncPipeline — simple 3-way sync.
 *
 * 1. Fetch fresh cloud list + local list per rule (1st snapshot)
 * 2. Load IndexedDB registry as "base" (last synced state)
 * 3. Detect actions via 3-way compare (local vs cloud vs base)
 * 4. Show summary → user confirms or cancels (nothing written yet)
 * 5. Execute actions
 * 6. Re-fetch cloud lists (2nd snapshot) and save to IndexedDB
 * ────────────────────────────────────────────────── */

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
  saveSettings: () => Promise<void>;
  onProgress?: (msg: string) => void;
  onAction?: (action: SyncAction, step: SyncStep) => void;
  /** Return false to cancel sync. */
  onSummary?: (summary: SyncSummary) => Promise<boolean>;
}

export async function runPipeline(
  steps: SyncStep[],
  ctx: PipelineContext,
): Promise<{ actionsExecuted: number; errors: string[] }> {
  let actionsExecuted = 0;
  const errors: string[] = [];

  /* ── 1. Per-rule: fetch fresh cloud + local lists ────────────── */
  const listCaches = new Map<string, { cloudList: FileEntry[]; localList: FileEntry[] }>();

  /* ── 2. Load base (IndexedDB) per account ────────────────────── */
  const accountBases = new Map<string, CloudFileEntry[]>();
  const loadedAccounts = new Set<string>();

  for (const step of steps) {
    const rule = ctx.settings.rules.find(r => r.id === step.ruleId);
    if (!rule) continue;
    const account = ctx.settings.accounts.find(a => a.id === rule.accountId);
    if (!account || loadedAccounts.has(account.id)) continue;
    loadedAccounts.add(account.id);
    try {
      accountBases.set(account.id, await loadCloudRegistry(account.id));
    } catch (e) {
      errors.push(`Failed to load registry for ${account.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /* ── 3. Detection phase ──────────────────────────────────────── */
  const stepActions = new Map<number, { step: SyncStep; rule: SyncRule; account: CloudAccount; provider: ICloudProvider; actions: SyncAction[] }>();

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    try {
      const rule = ctx.settings.rules.find(r => r.id === step.ruleId);
      if (!rule) { errors.push(`Rule not found: ${step.ruleId}`); continue; }
      const account = ctx.settings.accounts.find(a => a.id === rule.accountId);
      if (!account) { errors.push(`Account not found: ${rule.accountId}`); continue; }
      const provider = ctx.providers.get(account.id);
      if (!provider) { errors.push(`Provider not initialized: ${account.name}`); continue; }

      // Get or fetch lists (cached per rule)
      let cache = listCaches.get(rule.id);
      if (!cache) {
        const rawCloudList = await provider.listFiles(rule.cloudFolder);
        const cloudList = rawCloudList.filter(f => !hasDotSegment(f.path));
        const localList = listLocalFiles(ctx.app, rule.localFolder);
        cache = { cloudList, localList };
        listCaches.set(rule.id, cache);
      }

      // Build base set from IndexedDB registry for this rule's cloud folder
      const base = buildBaseForRule(accountBases.get(account.id) || [], rule.cloudFolder);

      const detector = OPERATION_DETECTORS[step.operation];
      if (!detector) { errors.push(`Unknown operation: ${step.operation}`); continue; }

      let actions = detector(cache.cloudList, cache.localList, base);

      // Prune redundant child deletes when parent folder is also deleted
      if (step.operation === "local-delete" || step.operation === "cloud-delete") {
        actions = pruneRedundantDeletes(actions);
      }

      // Hash-verify update actions to avoid false updates from mtime rounding
      if ((step.operation === "local-update" || step.operation === "cloud-update") && actions.length > 0) {
        actions = await hashVerifyUpdates(actions, cache.cloudList, rule, account, ctx);
      }

      // Filter files exceeding max size
      const maxBytes = (ctx.settings.maxFileSizeMB || 200) * 1e6;
      actions = actions.filter(a => a.isFolder || (a.sourceEntry?.size || 0) <= maxBytes);

      ctx.onProgress?.(`${actions.length} action(s) for ${step.operation}`);
      if (actions.length > 0) {
        stepActions.set(si, { step, rule, account, provider, actions });
      }
    } catch (e) {
      errors.push(`${OP_LABELS[step.operation] || step.operation}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /* ── 4. Summary confirmation ─────────────────────────────────── */
  if (ctx.onSummary) {
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
        // Cancel — nothing was written to disk or IndexedDB. Everything is as before.
        return { actionsExecuted: 0, errors: [] };
      }
    }
  }

  /* ── 5. Execution phase ──────────────────────────────────────── */
  // Track which accounts had actions executed (for registry save)
  const accountsWithActions = new Set<string>();

  for (const [, { step, rule, account, provider, actions }] of stepActions.entries()) {
    try {
      const LARGE_THRESHOLD = 50 * 1024 * 1024;
      const smallActions = actions.filter(a => a.isFolder || !a.sourceEntry || a.sourceEntry.size <= LARGE_THRESHOLD);
      const largeActions = actions.filter(a => !a.isFolder && a.sourceEntry && a.sourceEntry.size > LARGE_THRESHOLD);
      const concurrency = ctx.settings.concurrency || 4;
      let pendingSaves = 0;

      // Small files: concurrent
      let i = 0;
      const runNext = async (): Promise<void> => {
        while (i < smallActions.length) {
          const action = smallActions[i++];
          try {
            ctx.onAction?.(action, step);
            logAction(action, account, rule);
            const ok = await executeAction(action, rule, provider, ctx);
            if (!ok) continue;
            actionsExecuted++;
            accountsWithActions.add(account.id);
            pendingSaves++;
            if (pendingSaves >= 20) { pendingSaves = 0; await ctx.saveSettings(); }
            if (actionsExecuted % 5 === 0) await new Promise(r => setTimeout(r, 0));
          } catch (e) {
            const detail = (e as { status?: number })?.status ? `status ${(e as { status: number }).status}` : (e instanceof Error ? e.message : String(e));
            errors.push(`${OP_LABELS[action.operation] || action.operation} ${action.path}: ${detail}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, smallActions.length) }, () => runNext()));

      // Large files: sequential
      for (const action of largeActions) {
        try {
          ctx.onAction?.(action, step);
          logAction(action, account, rule);
          const ok = await executeAction(action, rule, provider, ctx);
          if (!ok) continue;
          actionsExecuted++;
          accountsWithActions.add(account.id);
          pendingSaves++;
          if (pendingSaves >= 20) { pendingSaves = 0; await ctx.saveSettings(); }
          await new Promise(r => setTimeout(r, 0));
        } catch (e) {
          const detail = (e as { status?: number })?.status ? `status ${(e as { status: number }).status}` : (e instanceof Error ? e.message : String(e));
          errors.push(`${OP_LABELS[action.operation] || action.operation} ${action.path}: ${detail}`);
        }
      }

      if (pendingSaves > 0) await ctx.saveSettings();

      // After cloud-delete, clean up empty local folders
      if (step.operation === "cloud-delete" && accountsWithActions.has(account.id)) {
        await cleanupEmptyFolders(ctx.app, rule.localFolder);
      }
    } catch (e) {
      errors.push(`${OP_LABELS[step.operation] || step.operation}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /* ── 6. Re-fetch cloud lists and save snapshot to IndexedDB ───── */
  // After execution, the cloud state has changed (uploads, deletes).
  // Re-fetch to get accurate post-execution snapshot with correct hashes/IDs.
  const savedAccounts = new Set<string>();
  for (const step of steps) {
    const rule = ctx.settings.rules.find(r => r.id === step.ruleId);
    if (!rule || savedAccounts.has(rule.accountId)) continue;
    savedAccounts.add(rule.accountId);
    const provider = ctx.providers.get(rule.accountId);
    if (!provider) continue;

    try {
      const rulesForAccount = ctx.settings.rules.filter(r => r.accountId === rule.accountId);
      const entries: CloudFileEntry[] = [];
      for (const r of rulesForAccount) {
        const pfx = folderPrefix(r.cloudFolder);
        // Fresh fetch from cloud to capture post-execution state
        const freshCloudList = (await provider.listFiles(r.cloudFolder)).filter(f => !hasDotSegment(f.path));
        for (const f of freshCloudList) {
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
      await saveCloudRegistry(rule.accountId, entries, provider.unsyncableFiles || []);
    } catch (e) {
      errors.push(`Failed to save registry for ${rule.accountId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { actionsExecuted, errors };
}

/* ── Summary Modal ─────────────────────────────────────────────── */

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
  constructor(app: App, private summary: SyncSummary) { super(app); }

  onOpen() {
    const { contentEl } = this;
    const s = this.summary;

    contentEl.createEl("h3", { text: `Sync summary — ${s.total} action(s)` });

    const counts = contentEl.createEl("div", { cls: "multisync-summary-counts" });
    if (s.add > 0) counts.createEl("span", { text: `➕ Add: ${s.add}` });
    if (s.update > 0) counts.createEl("span", { text: `↻ Update: ${s.update}` });
    if (s.delete > 0) counts.createEl("span", { text: `🗑 Delete: ${s.delete}`, cls: "multisync-summary-delete" });

    for (const d of s.details) {
      if (d.count === 0) continue;
      const details = contentEl.createEl("details");
      const friendlyOp = SUMMARY_LABELS[d.operation] || d.operation;
      const arrow = OP_ARROW[d.operation] || "";
      const dest = OP_DEST[d.operation] || "";

      const summaryEl = details.createEl("summary", { cls: "multisync-summary-detail-header" });
      summaryEl.createSpan({ text: arrow });
      const svgIcon = PROVIDERS[d.accountType as keyof typeof PROVIDERS]?.svgIcon;
      if (svgIcon) {
        const iconSpan = summaryEl.createSpan({ cls: "multisync-summary-icon" });
        setSvgContent(iconSpan, svgIcon);
      }
      const toCloud = ["local-add", "local-update", "local-delete"].includes(d.operation);
      summaryEl.createSpan({ text: `(${d.accountName}) ${friendlyOp}: ${dest} ${d.count} file(s)` });

      const list = details.createEl("div", { cls: "multisync-summary-file-list" });
      const maxShow = 50;
      const pathPrefix = toCloud ? d.localFolder : d.cloudFolder;
      for (const p of d.paths.slice(0, maxShow)) {
        list.createEl("div", { text: pathPrefix ? `${pathPrefix}/${p}` : p });
      }
      if (d.paths.length > maxShow) {
        list.createEl("div", { text: `… and ${d.paths.length - maxShow} more`, cls: "multisync-summary-more" });
      }
    }

    const btnRow = contentEl.createEl("div", { cls: "multisync-modal-btn-row-gap" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => { this.confirmed = false; this.close(); };
    const cls = s.delete > 0 ? "mod-warning" : "mod-cta";
    const confirmBtn = btnRow.createEl("button", { text: "Confirm sync", cls });
    confirmBtn.onclick = () => { this.confirmed = true; this.close(); };
  }

  onClose() { this.contentEl.empty(); this.resolve?.(this.confirmed); }
  awaitResult(): Promise<boolean> { return new Promise<boolean>(r => { this.resolve = r; }); }
}

/* ── Action Execution ──────────────────────────────────────────── */

function logAction(action: SyncAction, account: CloudAccount, rule: SyncRule) {
  const arrow = OP_ARROW[action.operation] || "";
  const opLabel = OP_LABELS[action.operation] || action.operation;
  const dest = OP_DEST[action.operation] || "";
  const toCloud = ["local-add", "local-update", "local-delete"].includes(action.operation);
  const destPath = toCloud ? `${rule.cloudFolder}/${action.path}` : `${rule.localFolder}/${action.path}`;
  console.debug(`${arrow} ${account.name} ${opLabel}: ${dest} ${destPath}`);
}

/** Returns true if executed, false if skipped (hash match). */
async function executeAction(
  action: SyncAction,
  rule: SyncRule,
  provider: ICloudProvider,
  ctx: PipelineContext,
): Promise<boolean> {
  const { app } = ctx;
  const base = normalizePath(rule.localFolder);
  const toVaultPath = (rel: string) => base ? `${base}/${rel}` : rel;

  switch (action.operation) {
    case "local-update": {
      const localPath = toVaultPath(action.path);
      const content = await app.vault.adapter.readBinary(localPath);
      if (action.sourceEntry?.size && Math.abs(content.byteLength - action.sourceEntry.size) > 1) return false;
      if (action.cloudHash) {
        const h = await computeLocalHash(provider.kind, content);
        if (h && h === action.cloudHash) {
          if (action.cloudMtime) try { await app.vault.adapter.writeBinary(localPath, content, { mtime: action.cloudMtime }); } catch { /* */ }
          return false;
        }
      }
      await provider.writeFile(rule.cloudFolder, action.path, content, action.sourceEntry?.mtime || Date.now(), action.sourceEntry?.ctime);
      break;
    }
    case "cloud-update": {
      const localPath = toVaultPath(action.path);
      if (action.sourceEntry?.hash) {
        try {
          const local = await app.vault.adapter.readBinary(localPath);
          const h = await computeLocalHash(provider.kind, local);
          if (h && h === action.sourceEntry.hash) {
            if (action.sourceEntry.mtime) try { await app.vault.adapter.writeBinary(localPath, local, { mtime: action.sourceEntry.mtime }); } catch { /* */ }
            return false;
          }
        } catch { /* proceed with download */ }
      }
      const content = await provider.readFile(rule.cloudFolder, action.path);
      await ensureParentDir(app, localPath);
      const mtime = action.sourceEntry?.mtime || Date.now();
      const ctime = action.sourceEntry?.ctime;
      await app.vault.adapter.writeBinary(localPath, content, { mtime, ...(ctime ? { ctime } : {}) });
      break;
    }
    case "local-add": {
      if (action.isFolder) {
        await provider.mkdir(rule.cloudFolder, action.path.replace(/\/$/, ""));
      } else {
        const localPath = toVaultPath(action.path);
        const content = await app.vault.adapter.readBinary(localPath);
        if (action.sourceEntry?.size && Math.abs(content.byteLength - action.sourceEntry.size) > 1) return false;
        await provider.writeFile(rule.cloudFolder, action.path, content, action.sourceEntry?.mtime || Date.now(), action.sourceEntry?.ctime);
      }
      break;
    }
    case "cloud-add": {
      if (action.isFolder) {
        await ensureParentDir(app, toVaultPath(action.path.replace(/\/$/, "") + "/x"));
      } else {
        const content = await provider.readFile(rule.cloudFolder, action.path);
        const localPath = toVaultPath(action.path);
        await ensureParentDir(app, localPath);
        const mtime = action.sourceEntry?.mtime || Date.now();
        const ctime = action.sourceEntry?.ctime;
        await app.vault.adapter.writeBinary(localPath, content, { mtime, ...(ctime ? { ctime } : {}) });
      }
      break;
    }
    case "local-delete": {
      const cloudId = action.sourceEntry?.cloudId;
      if (action.isFolder) {
        await provider.deleteFile(rule.cloudFolder, action.path.replace(/\/$/, ""), cloudId);
        break;
      }
      if (ctx.settings.backupBeforeCloudDelete) {
        const vaultPath = toVaultPath(action.path);
        const trashPath = `.trash/${vaultPath}`;
        if (!(await app.vault.adapter.exists(trashPath))) {
          try {
            const content = await provider.readFile(rule.cloudFolder, action.path);
            await ensureParentDir(app, vaultPath);
            await app.vault.adapter.writeBinary(vaultPath, content);
            const af = app.vault.getAbstractFileByPath(vaultPath);
            if (af) await app.fileManager.trashFile(af);
          } catch (e) {
            console.warn(`Skipping cloud delete for ${action.path}: backup failed — ${e instanceof Error ? e.message : String(e)}`);
            break;
          }
        }
      }
      await provider.deleteFile(rule.cloudFolder, action.path.replace(/\/$/, ""), cloudId);
      break;
    }
    case "cloud-delete": {
      const localPath = toVaultPath(action.path).replace(/\/$/, "");
      const af = app.vault.getAbstractFileByPath(localPath);
      if (af) {
        try { await app.fileManager.trashFile(af); }
        catch (e) { if (e instanceof Error && e.message?.includes("ENOENT")) break; throw e; }
      }
      break;
    }
  }
  return true;
}

/* ── Helpers ───────────────────────────────────────────────────── */

/** List local files under a vault folder, returning FileEntry[] with relative paths.
 *  Skips dotfiles/dotfolders (any path segment starting with '.') by default. */
export function listLocalFiles(app: App, localFolder: string): FileEntry[] {
  const entries: FileEntry[] = [];
  const normalized = normalizePath(localFolder);
  const prefix = normalized ? normalized + "/" : "";

  for (const file of app.vault.getFiles()) {
    const fp = normalizePath(file.path);
    if (prefix && !fp.startsWith(prefix)) continue;
    const rel = prefix ? fp.substring(prefix.length) : fp;
    if (!rel) continue;
    if (hasDotSegment(rel)) continue;
    entries.push({ path: rel, mtime: file.stat.mtime, size: file.stat.size, isFolder: false, ctime: file.stat.ctime });
  }
  for (const folder of app.vault.getAllFolders()) {
    const fp = normalizePath(folder.path);
    if (prefix && !fp.startsWith(prefix)) continue;
    const rel = prefix ? fp.substring(prefix.length) : fp;
    if (!rel) continue;
    if (hasDotSegment(rel)) continue;
    entries.push({ path: rel + "/", mtime: 0, size: 0, isFolder: true });
  }
  return entries;
}

/** True if any path segment starts with '.' (e.g. ".obsidian/themes/x.css") */
function hasDotSegment(relativePath: string): boolean {
  return relativePath.split("/").some(s => s.startsWith("."));
}

async function ensureParentDir(app: App, filePath: string): Promise<void> {
  const parts = normalizePath(filePath).split("/");
  parts.pop();
  if (parts.length === 0) return;
  const dirPath = parts.join("/");
  if (!(await app.vault.adapter.exists(dirPath))) await app.vault.adapter.mkdir(dirPath);
}

/** Normalize cloud folder to prefix (no leading/trailing slash). */
function folderPrefix(cloudFolder: string): string {
  if (!cloudFolder || cloudFolder === "/") return "";
  return cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder;
}

function stripPrefix(fullPath: string, prefix: string): string {
  if (!prefix) return fullPath;
  const ws = prefix + "/";
  return fullPath.startsWith(ws) ? fullPath.substring(ws.length) : "";
}

/** Build base set from IndexedDB registry for one cloud folder (case-insensitive paths). */
function buildBaseForRule(registry: CloudFileEntry[], cloudFolder: string): Set<string> | null {
  if (registry.length === 0) return null;
  const pfx = folderPrefix(cloudFolder);
  const paths = new Set<string>();
  for (const e of registry) {
    const rel = stripPrefix(e.path, pfx);
    if (!rel) continue;
    if (rel.split("/").some(s => s.startsWith("."))) continue;
    paths.add(rel.toLowerCase());
  }
  return paths.size > 0 ? paths : null;
}

/** Hash-verify update actions: skip when hash matches despite mtime difference. */
async function hashVerifyUpdates(
  actions: SyncAction[],
  cloudList: FileEntry[],
  rule: SyncRule,
  account: CloudAccount,
  ctx: PipelineContext,
): Promise<SyncAction[]> {
  const verified: SyncAction[] = [];
  const base = normalizePath(rule.localFolder);
  for (const a of actions) {
    if (a.isFolder) { verified.push(a); continue; }
    const cloud = cloudList.find(c => c.path.toLowerCase() === a.path.toLowerCase());
    if (cloud?.hash && a.sourceEntry?.size === cloud.size) {
      const vaultPath = base ? `${base}/${a.path}` : a.path;
      try {
        const content = await ctx.app.vault.adapter.readBinary(vaultPath);
        const localHash = await computeLocalHash(account.type, content);
        if (localHash === cloud.hash) continue;
      } catch { /* keep action */ }
    }
    verified.push(a);
  }
  return verified;
}

async function cleanupEmptyFolders(app: App, localFolder: string): Promise<void> {
  const normalized = normalizePath(localFolder);
  const folders = app.vault.getAllFolders()
    .filter(f => { const fp = normalizePath(f.path); return normalized ? fp.startsWith(normalized + "/") : fp.length > 0; })
    .sort((a, b) => b.path.length - a.path.length);
  for (const folder of folders) {
    const listed = await app.vault.adapter.list(folder.path);
    if ((listed.files || []).length === 0 && (listed.folders || []).length === 0) {
      try { await app.fileManager.trashFile(folder); } catch { /* */ }
    }
  }
}

function pruneRedundantDeletes(actions: SyncAction[]): SyncAction[] {
  const deletedFolders = new Set<string>();
  for (const a of actions) if (a.isFolder) deletedFolders.add(a.path.replace(/\/$/, "") + "/");
  if (deletedFolders.size === 0) return actions;
  return actions.filter(a => {
    const p = a.isFolder ? a.path.replace(/\/$/, "") + "/" : a.path;
    for (const folder of deletedFolders) {
      if (p !== folder && p.startsWith(folder)) return false;
    }
    return true;
  });
}
