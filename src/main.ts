import { Modal, Notice, Plugin } from "obsidian";
import type { MultiSyncSettings, CloudAccount, CloudProviderType } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import type { ICloudProvider } from "./providers/ICloudProvider";
import { PROVIDERS, PROVIDER_LIST } from "./providers/registry";
import { runPipeline, SyncSummaryModal } from "./sync/pipeline";
import { MultiSyncSettingsTab } from "./settings";
import { loadCloudRegistry, loadUnsyncableFiles, type CloudFileEntry } from "./utils/cloudRegistry";
import { setSvgContent } from "./utils/helpers";

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
  /** Quota cache per account ID */
  private quotaMap = new Map<string, { used: number; total: number } | null>();
  async onload() {
    await this.loadSettings();
    this.initProviders();

    // Ribbon icon for manual sync
    this.ribbonIconEl = this.addRibbonIcon("refresh-cw", "Multi cloud sync", async () => {
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
      void this.refreshGhostFiles();
      void this.refreshQuotas();
    });
  }

  onunload() {
    this.providers.clear();
    this.fileTreeObserver?.disconnect();
    this.fileTreeStyleEl?.remove();
    // Remove injected provider icons, ghost files, and quota spans
    document.querySelectorAll(".multisync-provider-icon").forEach(el => el.remove());
    document.querySelectorAll(".multisync-ghost-file").forEach(el => el.remove());
    document.querySelectorAll(".multisync-tree-quota").forEach(el => el.remove());
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
    // Migrate: move legacy deltaTokens map into account objects
    const legacySettings = this.settings as unknown as Record<string, unknown>;
    if (legacySettings.deltaTokens) {
      for (const [id, token] of Object.entries(legacySettings.deltaTokens as Record<string, string>)) {
        const acct = this.settings.accounts.find(a => a.id === id);
        if (acct) {
          if (!acct.deltaTokens) acct.deltaTokens = {};
          if (!acct.deltaTokens["me"]) acct.deltaTokens["me"] = token;
        }
      }
      delete legacySettings.deltaTokens;
      await this.saveData(this.settings);
    }
    // Migrate: single deltaToken → deltaTokens map
    for (const acct of this.settings.accounts) {
      const legacy = acct as unknown as Record<string, unknown>;
      if (legacy.deltaToken) {
        if (!acct.deltaTokens) acct.deltaTokens = {};
        if (!acct.deltaTokens["me"]) acct.deltaTokens["me"] = legacy.deltaToken as string;
        delete legacy.deltaToken;
        await this.saveData(this.settings);
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.setupFileTreeIcons();
    void this.refreshQuotas();
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
      void this.saveSettings();
    };

    return meta.createInstance(creds, onRefresh);
  }

  /** Build folder→provider map from rules and tag file explorer DOM */
  setupFileTreeIcons() {
    // Collect local folder → provider types (multiple providers possible per folder)
    const folderProviders = new Map<string, Set<CloudProviderType>>();
    for (const rule of this.settings.rules) {
      const account = this.settings.accounts.find(a => a.id === rule.accountId);
      if (!account) continue;
      const folder = rule.localFolder || "/";
      if (!folderProviders.has(folder)) folderProviders.set(folder, new Set());
      folderProviders.get(folder)!.add(account.type);
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
          this.tagQuotaInfo();
          startObserving();
        }, 150);
      });
      startObserving();
    }
  }

  /** Tag file explorer folder DOM elements with provider icons */
  private tagFileTreeFolders(folderProviders: Map<string, Set<CloudProviderType>>) {
    const allFolderTitles = document.querySelectorAll(".nav-folder-title");
    for (let i = 0; i < allFolderTitles.length; i++) {
      const el = allFolderTitles[i] as HTMLElement;
      const path = el.getAttribute("data-path");
      if (!path) continue;
      const providerTypes = folderProviders.get(path);
      // Remove all old icons
      el.querySelectorAll(".multisync-provider-icon").forEach(e => e.remove());
      if (providerTypes && providerTypes.size > 0) {
        const innerTitle = el.querySelector(".nav-folder-title-content");
        for (const providerType of providerTypes) {
          const svg = PROVIDERS[providerType]?.svgIcon;
          if (!svg) continue;
          const iconSpan = document.createElement("span");
          iconSpan.className = "multisync-provider-icon";
          iconSpan.setAttribute("data-provider", providerType);
          setSvgContent(iconSpan, svg);
          if (innerTitle) {
            el.insertBefore(iconSpan, innerTitle);
          } else {
            el.prepend(iconSpan);
          }
        }
      }
    }
  }

  /** Fetch quotas for all accounts and update file tree display */
  async refreshQuotas() {
    for (const account of this.settings.accounts) {
      const provider = this.providers.get(account.id);
      if (!provider) continue;
      try {
        const q = await provider.getQuota();
        this.quotaMap.set(account.id, q);
      } catch {
        this.quotaMap.set(account.id, null);
      }
    }
    this.tagQuotaInfo();
  }

  /** Tag file tree folders with quota information to the right of folder names */
  private tagQuotaInfo() {
    document.querySelectorAll(".multisync-tree-quota").forEach(el => el.remove());

    const folderAccounts = new Map<string, { accountId: string; type: CloudProviderType }[]>();
    for (const rule of this.settings.rules) {
      const folder = rule.localFolder || "/";
      if (!folderAccounts.has(folder)) folderAccounts.set(folder, []);
      const account = this.settings.accounts.find(a => a.id === rule.accountId);
      if (account) {
        folderAccounts.get(folder)!.push({ accountId: account.id, type: account.type });
      }
    }

    const allFolderTitles = document.querySelectorAll(".nav-folder-title");
    for (let i = 0; i < allFolderTitles.length; i++) {
      const titleEl = allFolderTitles[i] as HTMLElement;
      const path = titleEl.getAttribute("data-path");
      if (!path) continue;
      const accounts = folderAccounts.get(path);
      if (!accounts || accounts.length === 0) continue;

      for (const { accountId } of accounts) {
        const q = this.quotaMap.get(accountId);
        if (!q) continue;
        const pct = Math.min(100, Math.round((q.used / q.total) * 100));
        const usedGB = (q.used / 1e9).toFixed(1);
        const totalGB = (q.total / 1e9).toFixed(1);
        const color = pct > 90 ? "var(--text-error)" : pct > 70 ? "var(--text-warning)" : "var(--interactive-accent)";

        const wrapper = document.createElement("span");
        wrapper.className = "multisync-tree-quota";

        // SVG donut chart (12x12)
        const r = 4.5;
        const circ = 2 * Math.PI * r;
        const dashOffset = circ * (1 - pct / 100);
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", "12");
        svg.setAttribute("height", "12");
        svg.setAttribute("viewBox", "0 0 12 12");
        svg.classList.add("multisync-donut");
        const bgCircle = document.createElementNS(svgNS, "circle");
        bgCircle.setAttribute("cx", "6");
        bgCircle.setAttribute("cy", "6");
        bgCircle.setAttribute("r", String(r));
        bgCircle.setAttribute("fill", "none");
        bgCircle.setAttribute("stroke", "var(--background-modifier-border)");
        bgCircle.setAttribute("stroke-width", "2.5");
        svg.appendChild(bgCircle);
        const fgCircle = document.createElementNS(svgNS, "circle");
        fgCircle.setAttribute("cx", "6");
        fgCircle.setAttribute("cy", "6");
        fgCircle.setAttribute("r", String(r));
        fgCircle.setAttribute("fill", "none");
        fgCircle.setAttribute("stroke", color);
        fgCircle.setAttribute("stroke-width", "2.5");
        fgCircle.setAttribute("stroke-dasharray", String(circ));
        fgCircle.setAttribute("stroke-dashoffset", String(dashOffset));
        fgCircle.setAttribute("stroke-linecap", "round");
        fgCircle.setAttribute("transform", "rotate(-90 6 6)");
        svg.appendChild(fgCircle);
        wrapper.appendChild(svg);

        const text = document.createElement("span");
        text.className = "multisync-tree-quota-text";
        text.textContent = `${usedGB}/${totalGB} GB`;
        wrapper.appendChild(text);

        titleEl.appendChild(wrapper);
      }
    }
  }

  /**
   * Refresh ghost file data from cloud registries (IndexedDB).
   * Computes cloud-only files per local folder (files on cloud but not in vault).
   */
  async refreshGhostFiles() {
    const newMap = new Map<string, { name: string; size: number; providerType: CloudProviderType; reason?: string }[]>();

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
      const siblingTitle = childrenEl.querySelector<HTMLElement>(":scope > .nav-file > .nav-file-title");
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
        navTitle.className = "tree-item-self nav-file-title multisync-ghost-nav";
        navTitle.setAttribute("data-path", fullPath);
        if (marginStyle) navTitle.style.cssText = marginStyle;

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
        moreTitle.className = "tree-item-self nav-file-title multisync-ghost-nav-more";
        if (marginStyle) moreTitle.style.cssText = marginStyle;
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
    const modal = new Modal(this.app);
    modal.titleEl.textContent = `Cloud-only files in ${folderPath}`;
    const table = modal.contentEl.createEl("table", { cls: "multisync-ghost-table" });
    const thead = table.createEl("thead");
    const hrow = thead.createEl("tr");
    for (const h of ["File", "Description"]) {
      const th = hrow.createEl("th");
      th.textContent = h;
    }
    const tbody = table.createEl("tbody");
    for (const g of ghosts) {
      const row = tbody.createEl("tr");
      const tdName = row.createEl("td");
      tdName.textContent = g.name;
      const tdDesc = row.createEl("td");
      const sizeMB = g.size / 1e6;
      const sizeLabel = g.size === 0 ? "" : (sizeMB >= 1 ? `${sizeMB.toFixed(1)} MB` : `${(g.size / 1e3).toFixed(0)} KB`);
      const reason = g.reason || "Cloud-only";
      tdDesc.textContent = sizeLabel ? `${reason} (${sizeLabel})` : reason;
      tdDesc.addClass("is-muted");
    }
    modal.open();
  }

  /** Run the sync pipeline */
  async runSync(dryRun = false) {
    if (this.syncing) {
      new Notice("MultiSync: sync already in progress.");
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
      new Notice("MultiSync: no rules or pipeline steps configured. Go to settings.");
      return;
    }

    // Start animation
    this.syncing = true;
    this.ribbonIconEl?.addClass("multisync-spin");
    this.statusBarEl?.setText("⟳ syncing…");

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
        this.statusBarEl?.setText(`✓ synced`);
      }
      // Clear status bar after 10s
      setTimeout(() => this.statusBarEl?.setText(""), 10000);
    } catch (e: any) {
      new Notice(`MultiSync: Sync failed! ${e?.message || e}`);
      console.error("MultiSync:", e);
      this.statusBarEl?.setText("✗ sync failed");
      setTimeout(() => this.statusBarEl?.setText(""), 10000);
    } finally {
      this.syncing = false;
      this.ribbonIconEl?.removeClass("multisync-spin");
      void this.refreshGhostFiles();
      void this.refreshQuotas();
    }
  }
}
