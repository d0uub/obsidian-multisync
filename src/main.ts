import { Notice, Plugin, TFolder } from "obsidian";
import type { MultiSyncSettings, CloudAccount } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import type { ICloudProvider } from "./providers/ICloudProvider";
import { DropboxProvider } from "./providers/DropboxProvider";
import { OneDriveProvider } from "./providers/OneDriveProvider";
import { GDriveProvider } from "./providers/GDriveProvider";
import { runPipeline } from "./sync/pipeline";
import { MultiSyncSettingsTab } from "./settings";
import {
  CALLBACK_DROPBOX,
  CALLBACK_ONEDRIVE,
  CALLBACK_GDRIVE,
  exchangeDropboxCode,
  exchangeOneDriveCode,
  exchangeGDriveCode,
} from "./oauth";

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
  async onload() {
    await this.loadSettings();
    this.initProviders();

    // Track local file deletions for syncing to cloud
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        const filePath = file.path;
        const isFolder = file instanceof TFolder;
        for (const rule of this.settings.rules) {
          const prefix = rule.localFolder ? rule.localFolder + "/" : "";
          if (prefix && !filePath.startsWith(prefix)) continue;
          if (!prefix && filePath.startsWith(".")) continue; // skip hidden files at root
          let relativePath = prefix ? filePath.substring(prefix.length) : filePath;
          if (!relativePath) continue;
          if (isFolder && !relativePath.endsWith("/")) relativePath += "/";
          if (!this.settings.pendingCloudDeletes[rule.id]) {
            this.settings.pendingCloudDeletes[rule.id] = [];
          }
          if (!this.settings.pendingCloudDeletes[rule.id].some(d => d.path === relativePath)) {
            this.settings.pendingCloudDeletes[rule.id].push({ path: relativePath, deletedAt: Date.now() });
          }
        }
        this.saveSettings();
      })
    );

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
    this.addSettingTab(new MultiSyncSettingsTab(this.app, this));

    // ─── OAuth URI Handlers ───
    this.registerObsidianProtocolHandler(
      CALLBACK_DROPBOX,
      async (params) => {
        if (!params.code || !this.oauth2Info.verifier || !this.oauth2Info.accountId) {
          new Notice("MultiSync: Dropbox auth failed — missing code or verifier.");
          return;
        }
        try {
          const account = this.settings.accounts.find(a => a.id === this.oauth2Info.accountId);
          if (!account) throw new Error("Account not found");
          const result = await exchangeDropboxCode(
            account.credentials.appKey,
            params.code,
            this.oauth2Info.verifier,
            !!this.oauth2Info.manual
          );
          account.credentials.accessToken = result.access_token;
          account.credentials.refreshToken = result.refresh_token;
          account.credentials.tokenExpiry = String(Date.now() + result.expires_in * 1000 - 10000);
          await this.saveSettings();
          this.initProviders();
          new Notice("MultiSync: Dropbox connected!");
        } catch (e: any) {
          new Notice(`MultiSync: Dropbox auth failed — ${e?.message || e}`);
        }
        this.oauth2Info = {};
      }
    );

    this.registerObsidianProtocolHandler(
      CALLBACK_ONEDRIVE,
      async (params) => {
        if (!params.code || !this.oauth2Info.verifier || !this.oauth2Info.accountId) {
          new Notice("MultiSync: OneDrive auth failed — missing code or verifier.");
          return;
        }
        try {
          const account = this.settings.accounts.find(a => a.id === this.oauth2Info.accountId);
          if (!account) throw new Error("Account not found");
          const result = await exchangeOneDriveCode(
            account.credentials.clientId,
            params.code,
            this.oauth2Info.verifier,
            !!this.oauth2Info.manual
          );
          account.credentials.accessToken = result.access_token;
          account.credentials.refreshToken = result.refresh_token;
          account.credentials.tokenExpiry = String(Date.now() + result.expires_in * 1000 - 120000);
          await this.saveSettings();
          this.initProviders();
          new Notice("MultiSync: OneDrive connected!");
        } catch (e: any) {
          new Notice(`MultiSync: OneDrive auth failed — ${e?.message || e}`);
        }
        this.oauth2Info = {};
      }
    );

    this.registerObsidianProtocolHandler(
      CALLBACK_GDRIVE,
      async (params) => {
        if (!params.code || !this.oauth2Info.verifier || !this.oauth2Info.accountId) {
          new Notice("MultiSync: Google Drive auth failed — missing code or verifier.");
          return;
        }
        try {
          const account = this.settings.accounts.find(a => a.id === this.oauth2Info.accountId);
          if (!account) throw new Error("Account not found");
          const result = await exchangeGDriveCode(
            account.credentials.clientId,
            account.credentials.clientSecret,
            params.code,
            this.oauth2Info.verifier,
            !!this.oauth2Info.manual
          );
          account.credentials.accessToken = result.access_token;
          account.credentials.refreshToken = result.refresh_token;
          account.credentials.tokenExpiry = String(Date.now() + result.expires_in * 1000 - 120000);
          await this.saveSettings();
          this.initProviders();
          new Notice("MultiSync: Google Drive connected!");
        } catch (e: any) {
          new Notice(`MultiSync: Google Drive auth failed — ${e?.message || e}`);
        }
        this.oauth2Info = {};
      }
    );
  }

  onunload() {
    this.providers.clear();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
    const onRefresh = (token: string, refresh: string, expiry: number) => {
      account.credentials.accessToken = token;
      account.credentials.refreshToken = refresh;
      account.credentials.tokenExpiry = String(expiry);
      this.saveSettings();
    };

    switch (account.type) {
      case "dropbox":
        return new DropboxProvider(
          creds.accessToken || "",
          creds.refreshToken || "",
          creds.appKey || "",
          parseInt(creds.tokenExpiry || "0", 10),
          onRefresh
        );
      case "onedrive":
        if (!account.credentials.clientId) {
          account.credentials.clientId = "03beb548-4548-4835-ba4e-18ac1f469442";
        }
        return new OneDriveProvider(
          creds.accessToken || "",
          creds.refreshToken || "",
          creds.clientId || "",
          parseInt(creds.tokenExpiry || "0", 10),
          onRefresh
        );
      case "gdrive":
        return new GDriveProvider(
          creds.accessToken || "",
          creds.refreshToken || "",
          creds.clientId || "",
          creds.clientSecret || "",
          parseInt(creds.tokenExpiry || "0", 10),
          onRefresh
        );
      default:
        return null;
    }
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

    try {
      const result = await runPipeline(pipeline, {
        app: this.app,
        settings: this.settings,
        providers: this.providers,
        saveSettings: () => this.saveSettings(),
        dryRun,
        onProgress: (msg) => {
          console.log(`MultiSync: ${msg}`);
          // Extract action count from "operation: N action(s)"
          const m = msg.match(/(\d+) action\(s\)/);
          if (m) totalActions += parseInt(m[1]);
          this.statusBarEl?.setText(`⟳ ${completedActions}/${totalActions}`);
        },
        onAction: (action, step) => {
          completedActions++;
          this.statusBarEl?.setText(`⟳ ${completedActions}/${totalActions}`);
          const prefix = dryRun ? "[DRY RUN]" : "";
          console.log(
            `MultiSync: ${prefix} [${step.ruleId}] ${action.operation} → ${action.path}`
          );
          if (dryRun) {
            new Notice(`Preview: ${action.operation} ${action.path}`);
          }
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const mode = dryRun ? "[DRY RUN] " : "";
      if (result.errors.length > 0) {
        new Notice(
          `MultiSync: ${mode}Done in ${elapsed}s. ${result.actionsExecuted} actions, ${result.errors.length} error(s).`
        );
        for (const err of result.errors) {
          console.error(`MultiSync Error: ${err}`);
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
    }
  }
}
