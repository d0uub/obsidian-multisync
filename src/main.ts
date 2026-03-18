import { Notice, Plugin } from "obsidian";
import type { MultiSyncSettings, CloudAccount } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import type { ICloudProvider } from "./providers/ICloudProvider";
import { DropboxProvider } from "./providers/DropboxProvider";
import { OneDriveProvider } from "./providers/OneDriveProvider";
import { GDriveProvider } from "./providers/GDriveProvider";
import { runPipeline } from "./sync/pipeline";
import { MultiSyncSettingsTab } from "./settings";

export default class MultiSyncPlugin extends Plugin {
  settings!: MultiSyncSettings;
  providers: Map<string, ICloudProvider> = new Map();

  async onload() {
    await this.loadSettings();
    this.initProviders();

    // Ribbon icon for manual sync
    this.addRibbonIcon("cloud", "Multi Cloud Sync", async () => {
      await this.runSync();
    });

    // Command: Run full pipeline
    this.addCommand({
      id: "run-sync-pipeline",
      name: "Run sync pipeline",
      callback: async () => {
        await this.runSync();
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
  async runSync() {
    if (this.settings.pipeline.length === 0) {
      new Notice("MultiSync: No pipeline steps configured. Go to Settings.");
      return;
    }

    new Notice("MultiSync: Starting sync...");
    const startTime = Date.now();

    try {
      const result = await runPipeline(this.settings.pipeline, {
        app: this.app,
        settings: this.settings,
        providers: this.providers,
        saveSettings: () => this.saveSettings(),
        onProgress: (msg) => {
          console.log(`MultiSync: ${msg}`);
        },
        onAction: (action, step) => {
          console.log(
            `MultiSync: [${step.ruleId}] ${action.operation} → ${action.path}`
          );
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (result.errors.length > 0) {
        new Notice(
          `MultiSync: Done in ${elapsed}s. ${result.actionsExecuted} actions, ${result.errors.length} error(s).`
        );
        for (const err of result.errors) {
          console.error(`MultiSync Error: ${err}`);
        }
      } else {
        new Notice(
          `MultiSync: Done in ${elapsed}s. ${result.actionsExecuted} action(s) synced.`
        );
      }
    } catch (e: any) {
      new Notice(`MultiSync: Sync failed! ${e?.message || e}`);
      console.error("MultiSync:", e);
    }
  }
}
