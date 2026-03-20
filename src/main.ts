import { Notice, Plugin } from "obsidian";
import type { MultiSyncSettings, CloudAccount } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import type { ICloudProvider } from "./providers/ICloudProvider";
import { PROVIDERS, PROVIDER_LIST } from "./providers/registry";
import { runPipeline } from "./sync/pipeline";
import { MultiSyncSettingsTab } from "./settings";

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
            new Notice(`MultiSync: ${meta.label} connected!`);
            this.settingsTab?.display();
            // Pre-fetch full file list for the new account in background
            this.prefetchAccountDelta(account.id);
          } catch (e: any) {
            new Notice(`MultiSync: ${meta.label} auth failed — ${e?.message || e}`);
          }
          this.oauth2Info = {};
        }
      );
    }
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

  /** Pre-fetch the full file list for an account in the background (called after OAuth). */
  async prefetchAccountDelta(accountId: string): Promise<void> {
    const provider = this.providers.get(accountId);
    if (!provider) return;
    try {
      const { applyDeltaChanges } = await import("./utils/cloudRegistry");
      const deltaToken = this.settings.deltaTokens?.[accountId] || "";
      const result = await provider.syncAccountDelta(deltaToken);
      await applyDeltaChanges(accountId, result.changes, result.isFullEnum);
      if (!this.settings.deltaTokens) this.settings.deltaTokens = {};
      this.settings.deltaTokens[accountId] = result.newDeltaToken;
      await this.saveSettings();
      const account = this.settings.accounts.find(a => a.id === accountId);
      console.log(`MultiSync: Pre-fetched ${result.changes.length} items for ${account?.name || accountId}`);
    } catch (e: any) {
      console.warn(`MultiSync: Pre-fetch failed for ${accountId}:`, e?.message || e);
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
          const m = msg.match(/(\d+) action\(s\)/);
          if (m) totalActions += parseInt(m[1]);
          this.statusBarEl?.setText(`⟳ ${completedActions}/${totalActions}`);
        },
        onAction: (action, step) => {
          completedActions++;
          this.statusBarEl?.setText(`⟳ ${completedActions}/${totalActions}`);
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
    }
  }
}
