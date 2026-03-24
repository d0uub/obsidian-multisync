import { Notice, Plugin } from "obsidian";
import type { MultiSyncSettings, CloudAccount, CloudProviderType } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import type { ICloudProvider } from "./providers/ICloudProvider";
import { PROVIDERS, PROVIDER_LIST } from "./providers/registry";
import { runPipeline, SyncSummaryModal } from "./sync/pipeline";
import { MultiSyncSettingsTab } from "./settings";
import { loadCloudRegistry, loadUnsyncableFiles, type CloudFileEntry } from "./utils/cloudRegistry";

/** Transient OAuth state shared between settings tab and URI callbacks */
export interface OAuth2Info {
  verifier?: string;
  accountId?: string;
  manual?: boolean;
}

export default class MultiSyncPlugin extends Plugin {
  settings!: MultiSyncSettings;
  providers: Map<string, ICloudProvider> = new Map();
  oauth2Info: OAuth2Info = {};

  private ribbonIconEl: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private syncing = false;
  settingsTab: MultiSyncSettingsTab | null = null;
  private fileTreeObserver: MutationObserver | null = null;
  private fileTreeStyleEl: HTMLStyleElement | null = null;
  /** Cloud-only files per local folder path */
  private ghostFileMap: Map<string, { name: string; size: number; providerType: CloudProviderType; reason?: string }[]> = new Map();
  async onload() {
    await this.loadSettings();
    this.initProviders();

    // Ribbon icon for manual sync
    this.ribbonIconEl = this.addRibbonIcon("refresh-cw", "Multi Cloud Sync", async () => {
      await this.runSync();
    });

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText("");

    // Command: Run full pipeline
    this.addCommand({
      id: "run-sync-pipeline",
      name: "Run sync pipeline",
      callback: async () => {
        await this.runSync();
      },
    });

    // Command: Dry run (preview actions without executing)
    this.addCommand({
      id: "dry-run-sync",
      name: "Dry run sync (preview only)",
      callback: async () => {
        await this.runSync(true);
      },
    });

    // Command: Run single rule (all operations)
    this.addCommand({
      id: "run-sync-rule",
      name: "Run sync for a specific rule",
      callback: async () => {
        // For now, run full pipeline. Settings tab will allow per-rule runs.
        await this.runSync();
      },
    });

    // Settings tab
    this.settingsTab = new MultiSyncSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // ─── OAuth URI Handlers (registered from provider registry) ───
    for (const meta of PROVIDER_LIST) {
      this.registerObsidianProtocolHandler(
        meta.callbackProtocol,
        async (params) => {
          if (!params.code || !this.oauth2Info.verifier || !this.oauth2Info.accountId) {
            new Notice(`MultiSync: ${meta.label} auth failed — missing code or verifier.`);
            return;
          }
          try {
            const account = this.settings.accounts.find(a => a.id === this.oauth2Info.accountId);
            if (!account) throw new Error("Account not found");
            const result = await meta.exchangeCode(
              account.credentials,
              params.code,
              this.oauth2Info.verifier,
              !!this.oauth2Info.manual,
            );
            account.credentials.accessToken = result.accessToken;
            account.credentials.refreshToken = result.refreshToken;
            account.credentials.tokenExpiry = String(Date.now() + result.expiresIn * 1000 - 60000);
            await this.saveSettings();
            this.initProviders();
            // Auto-name account from cloud identity
            const provider = this.providers.get(account.id);
            if (provider) {
              try {
                const name = await provider.getDisplayName();
                if (name && name !== account.name) {
                  account.name = name;
                  await this.saveSettings();
                }
              } catch { /* keep existing name */ }
            }
            new Notice(`MultiSync: ${account.name} connected!`);
            this.settingsTab?.display();
          } catch (e: any) {
            new Notice(`MultiSync: ${meta.label} auth failed — ${e?.message || e}`);
          }
          this.oauth2Info = {};
        }
      );
    }

    // Setup file tree provider icons after layout is ready
    this.app.workspace.onLayoutReady(() => {
      this.setupFileTreeIcons();
      this.refreshGhostFiles();
    });
  }

  onunload() {
    this.providers.clear();
    this.fileTreeObserver?.disconnect();
    this.fileTreeStyleEl?.remove();
    // Remove injected provider icons and ghost files
    document.querySelectorAll(".multisync-provider-icon").forEach(el => el.remove());
    document.querySelectorAll(".multisync-ghost-file").forEach(el => el.remove());
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
    // Migrate: move legacy deltaTokens map into account objects
    if (this.settings.deltaTokens) {
      for (const [id, token] of Object.entries(this.settings.deltaTokens)) {
        const acct = this.settings.accounts.find(a => a.id === id);
        if (acct) {
          if (!acct.deltaTokens) acct.deltaTokens = {};
          if (!acct.deltaTokens["me"]) acct.deltaTokens["me"] = token;
        }
      }
      delete this.settings.deltaTokens;
      await this.saveData(this.settings);
    }
    // Migrate: single deltaToken → deltaTokens map
    for (const acct of this.settings.accounts) {
      if ((acct as any).deltaToken) {
        if (!acct.deltaTokens) acct.deltaTokens = {};
        if (!acct.deltaTokens["me"]) acct.deltaTokens["me"] = (acct as any).deltaToken;
        delete (acct as any).deltaToken;
        await this.saveData(this.settings);
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.setupFileTreeIcons();
  }

  /** Initialize cloud providers from saved account credentials */
  initProviders() {
    this.providers.clear();
    for (const account of this.settings.accounts) {
      try {
        const provider = this.createProvider(account);
        if (provider) {
          this.providers.set(account.id, provider);
        }
      } catch (e) {
        console.error(
          `MultiSync: Failed to init provider for ${account.name}:`,
          e
        );
      }
    }
  }

  createProvider(account: CloudAccount): ICloudProvider | null {
    const creds = account.credentials;
    const meta = PROVIDERS[account.type];
    if (!meta) return null;

    meta.autoFillCreds(creds);

    const onRefresh = (token: string, refresh: string, expiry: number) => {
      account.credentials.accessToken = token;
      account.credentials.refreshToken = refresh;
      account.credentials.tokenExpiry = String(expiry);
      this.saveSettings();
    };

    return meta.createInstance(creds, onRefresh);
  }

  /** Build folder→provider map from rules and tag file explorer DOM */
  setupFileTreeIcons() {
    // Collect local folder → provider type
    const folderProviders = new Map<string, CloudProviderType>();
    for (const rule of this.settings.rules) {
      const account = this.settings.accounts.find(a => a.id === rule.accountId);
      if (!account) continue;
      const folder = rule.localFolder || "/";
      folderProviders.set(folder, account.type);
    }

    // Remove old style sheet if any
    if (this.fileTreeStyleEl) {
      this.fileTreeStyleEl.remove();
      this.fileTreeStyleEl = undefined as any;
    }

    // Tag DOM and observe
    this.tagFileTreeFolders(folderProviders);
    this.injectGhostFiles();
    this.fileTreeObserver?.disconnect();
    const explorerEl = document.querySelector(".nav-files-container");
    if (explorerEl) {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const startObserving = () =>
        this.fileTreeObserver!.observe(explorerEl, { childList: true, subtree: true });
      this.fileTreeObserver = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.fileTreeObserver!.disconnect();
          this.tagFileTreeFolders(folderProviders);
          this.injectGhostFiles();
          startObserving();
        }, 150);
      });
      startObserving();
    }
  }

  /** Tag file explorer folder DOM elements with provider icons */
  private tagFileTreeFolders(folderProviders: Map<string, CloudProviderType>) {
    const allFolderTitles = document.querySelectorAll(".nav-folder-title");
    for (let i = 0; i < allFolderTitles.length; i++) {
      const el = allFolderTitles[i] as HTMLElement;
      const path = el.getAttribute("data-path");
      if (!path) continue;
      const providerType = folderProviders.get(path);
      const existing = el.querySelector(".multisync-provider-icon") as HTMLElement | null;
      if (providerType) {
        const svg = PROVIDERS[providerType as keyof typeof PROVIDERS]?.svgIcon;
        if (!svg) continue;
        if (existing) {
          // Already has icon — check if correct type
          if (existing.getAttribute("data-provider") === providerType) continue;
          existing.remove();
        }
        const iconSpan = document.createElement("span");
        iconSpan.className = "multisync-provider-icon";
        iconSpan.setAttribute("data-provider", providerType);
        iconSpan.innerHTML = svg;
        iconSpan.style.cssText = "display:inline-flex;align-items:center;margin-right:4px;opacity:0.7;flex-shrink:0;width:14px;height:14px;position:relative;top:1px;";
        // Scale SVG inside
        const svgEl = iconSpan.querySelector("svg");
        if (svgEl) {
          svgEl.style.width = "14px";
          svgEl.style.height = "14px";
        }
        // Insert before the folder name text element
        const innerTitle = el.querySelector(".nav-folder-title-content");
        if (innerTitle) {
          el.insertBefore(iconSpan, innerTitle);
        } else {
          el.prepend(iconSpan);
        }
      } else if (existing) {
        existing.remove();
      }
    }
  }

  /**
   * Refresh ghost file data from cloud registries (IndexedDB).
   * Computes cloud-only files per local folder (files on cloud but not in vault).
   */
  async refreshGhostFiles() {
    const newMap = new Map<string, { name: string; size: number; providerType: CloudProviderType }[]>();

    for (const rule of this.settings.rules) {
      const account = this.settings.accounts.find(a => a.id === rule.accountId);
      if (!account) continue;

      const registry = await loadCloudRegistry(account.id);
      if (!registry.length) continue;

      const cloudFolder = rule.cloudFolder || "";
      const localFolder = rule.localFolder || "/";
      const pfx = cloudFolder.startsWith("/") ? cloudFolder.substring(1) : cloudFolder;
      const pfxSlash = pfx ? pfx + "/" : "";

      // Get cloud-relative paths under this rule's cloud folder
      const cloudRelPaths: { rel: string; entry: CloudFileEntry }[] = [];
      for (const e of registry) {
        if (e.isFolder) continue;
        const full = e.path;
        if (pfx && !full.startsWith(pfxSlash) && full !== pfx) continue;
        const rel = pfx ? full.substring(pfxSlash.length) : full;
        if (!rel) continue;
        if (rel.split("/").some(s => s.startsWith("."))) continue;
        cloudRelPaths.push({ rel, entry: e });
      }

      // Get local vault files under this rule's local folder
      const localFiles = new Set<string>();
      const folder = this.app.vault.getAbstractFileByPath(localFolder);
      if (folder && "children" in folder) {
        const collectFiles = (f: any, prefix: string) => {
          for (const child of f.children || []) {
            const relPath = prefix ? `${prefix}/${child.name}` : child.name;
            if ("children" in child) {
              collectFiles(child, relPath);
            } else {
              localFiles.add(relPath.toLowerCase());
            }
          }
        };
        collectFiles(folder, "");
      }

      // Find cloud-only files (not in local vault)
      for (const { rel, entry } of cloudRelPaths) {
        if (localFiles.has(rel.toLowerCase())) continue;
        const parts = rel.split("/");
        const fileName = parts.pop()!;
        const subFolder = parts.length > 0
          ? (localFolder === "/" ? parts.join("/") : `${localFolder}/${parts.join("/")}`)
          : localFolder;

        if (!newMap.has(subFolder)) newMap.set(subFolder, []);
        newMap.get(subFolder)!.push({
          name: fileName,
          size: entry.size,
          providerType: account.type,
          reason: "Cloud-only",
        });
      }

      // Include unsyncable files (native formats, etc.) as ghosts
      const unsyncable = await loadUnsyncableFiles(account.id);
      for (const u of unsyncable) {
        // u.path is relative to cloud folder; map to local folder structure
        const parts = u.path.split("/");
        const fileName = parts.pop()!;
        const subFolder = parts.length > 0
          ? (localFolder === "/" ? parts.join("/") : `${localFolder}/${parts.join("/")}`)
          : localFolder;
        // Skip if already added from registry (shouldn't happen, but guard)
        const existing = newMap.get(subFolder);
        if (existing?.some(g => g.name.toLowerCase() === fileName.toLowerCase())) continue;

        if (!newMap.has(subFolder)) newMap.set(subFolder, []);
        newMap.get(subFolder)!.push({
          name: fileName,
          size: u.size,
          providerType: account.type,
          reason: u.reason,
        });
      }
    }

    this.ghostFileMap = newMap;
    this.injectGhostFiles();
  }

  /** Inject ghost file DOM entries into the file explorer for cloud-only files */
  private injectGhostFiles() {
    // Remove old ghost entries
    document.querySelectorAll(".multisync-ghost-file").forEach(el => el.remove());

    if (this.ghostFileMap.size === 0) return;

    const allFolderTitles = document.querySelectorAll(".nav-folder-title");
    for (let i = 0; i < allFolderTitles.length; i++) {
      const titleEl = allFolderTitles[i] as HTMLElement;
      const folderPath = titleEl.getAttribute("data-path");
      if (!folderPath) continue;

      const ghosts = this.ghostFileMap.get(folderPath);
      if (!ghosts || ghosts.length === 0) continue;

      const folderEl = titleEl.parentElement;
      if (!folderEl) continue;
      const childrenEl = folderEl.querySelector(":scope > .nav-folder-children");
      if (!childrenEl) continue;

      if (folderEl.classList.contains("is-collapsed")) continue;

      // Get indentation from sibling
      const siblingTitle = childrenEl.querySelector(":scope > .nav-file > .nav-file-title") as HTMLElement | null;
      const marginStyle = siblingTitle?.style.cssText
        .split(";")
        .filter(s => s.includes("margin-inline-start") || s.includes("padding-inline-start"))
        .join(";") || "";

      // Show up to 3 ghost files inline, then "... and N more" clickable summary
      const MAX_INLINE = 3;
      const shown = ghosts.slice(0, MAX_INLINE);
      for (const ghost of shown) {
        const fullPath = folderPath === "/" ? ghost.name : `${folderPath}/${ghost.name}`;
        const dotIdx = ghost.name.lastIndexOf(".");
        const baseName = dotIdx > 0 ? ghost.name.substring(0, dotIdx) : ghost.name;
        const ext = dotIdx > 0 ? ghost.name.substring(dotIdx + 1) : "";

        const navFile = document.createElement("div");
        navFile.className = "tree-item nav-file multisync-ghost-file";
        navFile.setAttribute("data-ghost-path", fullPath);

        const navTitle = document.createElement("div");
        navTitle.className = "tree-item-self nav-file-title";
        navTitle.setAttribute("data-path", fullPath);
        navTitle.style.cssText = `opacity:0.45;cursor:default;${marginStyle ? marginStyle + ";" : ""}`;

        const nameEl = document.createElement("div");
        nameEl.className = "tree-item-inner nav-file-title-content";
        nameEl.textContent = baseName;
        navTitle.appendChild(nameEl);

        if (ext) {
          const tagEl = document.createElement("div");
          tagEl.className = "nav-file-tag";
          tagEl.textContent = ext;
          navTitle.appendChild(tagEl);
        }

        navFile.appendChild(navTitle);
        childrenEl.appendChild(navFile);
      }

      if (ghosts.length > MAX_INLINE) {
        const moreCount = ghosts.length - MAX_INLINE;
        const moreEl = document.createElement("div");
        moreEl.className = "tree-item nav-file multisync-ghost-file";
        const moreTitle = document.createElement("div");
        moreTitle.className = "tree-item-self nav-file-title";
        moreTitle.style.cssText = `opacity:0.45;cursor:pointer;font-style:italic;${marginStyle ? marginStyle + ";" : ""}`;
        const moreName = document.createElement("div");
        moreName.className = "tree-item-inner nav-file-title-content";
        moreName.textContent = `… and ${moreCount} more cloud-only files`;
        moreTitle.appendChild(moreName);
        moreEl.appendChild(moreTitle);
        moreEl.addEventListener("click", (e) => {
          e.stopPropagation();
          this.showGhostFilesModal(folderPath, ghosts);
        });
        childrenEl.appendChild(moreEl);
      }
    }
  }

  /** Show a modal with full ghost file details for a folder */
  private showGhostFilesModal(
    folderPath: string,
    ghosts: { name: string; size: number; providerType: CloudProviderType; reason?: string }[]
  ) {
    const { Modal } = require("obsidian");
    const modal = new Modal(this.app);
    modal.titleEl.textContent = `Cloud-only files in ${folderPath}`;
    const table = modal.contentEl.createEl("table", { cls: "multisync-ghost-table" });
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:0.9em;";
    const thead = table.createEl("thead");
    const hrow = thead.createEl("tr");
    for (const h of ["File", "Description"]) {
      const th = hrow.createEl("th");
      th.textContent = h;
      th.style.cssText = "text-align:left;padding:4px 8px;border-bottom:1px solid var(--background-modifier-border);";
    }
    const tbody = table.createEl("tbody");
    for (const g of ghosts) {
      const row = tbody.createEl("tr");
      const tdName = row.createEl("td");
      tdName.textContent = g.name;
      tdName.style.cssText = "padding:4px 8px;border-bottom:1px solid var(--background-modifier-border-hover);";
      const tdDesc = row.createEl("td");
      const sizeMB = g.size / 1e6;
      const sizeLabel = g.size === 0 ? "" : (sizeMB >= 1 ? `${sizeMB.toFixed(1)} MB` : `${(g.size / 1e3).toFixed(0)} KB`);
      const reason = g.reason || "Cloud-only";
      tdDesc.textContent = sizeLabel ? `${reason} (${sizeLabel})` : reason;
      tdDesc.style.cssText = "padding:4px 8px;border-bottom:1px solid var(--background-modifier-border-hover);color:var(--text-muted);";
    }
    modal.open();
  }

  /** Run the sync pipeline */
  async runSync(dryRun = false) {
    if (this.syncing) {
      new Notice("MultiSync: Sync already in progress.");
      return;
    }

    // Build pipeline: advanced uses custom pipeline, default generates standard order from rules
    let pipeline = this.settings.pipeline;
    if (!this.settings.advancedMode) {
      const ops: import("./types").SyncOpType[] = [
        "cloud-update", "local-update", "cloud-add", "local-add",
        "local-delete", "cloud-delete",
      ];
      pipeline = [];
      for (const rule of this.settings.rules) {
        for (const op of ops) {
          pipeline.push({ ruleId: rule.id, operation: op });
        }
      }
    }

    if (pipeline.length === 0) {
      new Notice("MultiSync: No rules or pipeline steps configured. Go to Settings.");
      return;
    }

    // Start animation
    this.syncing = true;
    this.ribbonIconEl?.addClass("multisync-spin");
    this.statusBarEl?.setText("⟳ Syncing…");

    new Notice(dryRun ? "MultiSync: Dry run starting..." : "MultiSync: Starting sync...");
    const startTime = Date.now();
    let totalActions = 0;
    let completedActions = 0;
    let statusDirty = false;
    let statusTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStatus = () => {
      if (statusDirty) {
        this.statusBarEl?.setText(`⟳ ${completedActions}/${totalActions}`);
        statusDirty = false;
      }
      statusTimer = null;
    };
    const scheduleStatus = () => {
      statusDirty = true;
      if (!statusTimer) statusTimer = setTimeout(flushStatus, 200);
    };

    try {
      const result = await runPipeline(pipeline, {
        app: this.app,
        settings: this.settings,
        providers: this.providers,
        saveSettings: () => this.saveSettings(),
        dryRun,

        onProgress: (msg) => {
          const m = msg.match(/(\d+) action\(s\)/);
          if (m) totalActions += parseInt(m[1]);
          scheduleStatus();
        },
        onAction: (action, step) => {
          completedActions++;
          scheduleStatus();
          if (dryRun) {
            new Notice(`Preview: ${action.operation} ${action.path}`);
          }
        },
        onSummary: async (summary) => {
          const modal = new SyncSummaryModal(this.app, summary);
          modal.open();
          return modal.awaitResult();
        },
      });
      if (statusTimer) { clearTimeout(statusTimer); flushStatus(); }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const mode = dryRun ? "[DRY RUN] " : "";
      if (result.errors.length > 0) {
        new Notice(
          `MultiSync: ${mode}Done in ${elapsed}s. ${result.actionsExecuted} actions, ${result.errors.length} error(s).`
        );
        for (const err of result.errors) {
          console.error(err);
        }
        this.statusBarEl?.setText(`✗ ${result.errors.length} error(s)`);
      } else {
        new Notice(
          `MultiSync: ${mode}Done in ${elapsed}s. ${result.actionsExecuted} action(s) ${dryRun ? "detected" : "synced"}.`
        );
        this.statusBarEl?.setText(`✓ Synced`);
      }
      // Clear status bar after 10s
      setTimeout(() => this.statusBarEl?.setText(""), 10000);
    } catch (e: any) {
      new Notice(`MultiSync: Sync failed! ${e?.message || e}`);
      console.error("MultiSync:", e);
      this.statusBarEl?.setText("✗ Sync failed");
      setTimeout(() => this.statusBarEl?.setText(""), 10000);
    } finally {
      this.syncing = false;
      this.ribbonIconEl?.removeClass("multisync-spin");
      this.refreshGhostFiles();
    }
  }
}
