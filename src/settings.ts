import {
  App,
  Notice,
  PluginSettingTab,
  Setting,
  TextComponent,
  DropdownComponent,
} from "obsidian";
import type MultiSyncPlugin from "./main";
import type {
  CloudAccount,
  CloudProviderType,
  SyncRule,
  SyncStep,
  SyncOpType,
} from "./types";

const CLOUD_TYPES: { value: CloudProviderType; label: string }[] = [
  { value: "dropbox", label: "Dropbox" },
  { value: "onedrive", label: "OneDrive" },
  { value: "gdrive", label: "Google Drive" },
];

const ALL_OPS: { value: SyncOpType; label: string }[] = [
  { value: "local-update", label: "Local → Cloud (update)" },
  { value: "cloud-update", label: "Cloud → Local (update)" },
  { value: "local-add", label: "Push new local files" },
  { value: "cloud-add", label: "Pull new cloud files" },
  { value: "local-delete", label: "Delete cloud (local deleted)" },
  { value: "cloud-delete", label: "Delete local (cloud deleted)" },
];

export class MultiSyncSettingsTab extends PluginSettingTab {
  plugin: MultiSyncPlugin;

  constructor(app: App, plugin: MultiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ─── Cloud Accounts ───
    containerEl.createEl("h2", { text: "Cloud Accounts" });

    for (const account of this.plugin.settings.accounts) {
      this.renderAccount(containerEl, account);
    }

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("+ Add Account").onClick(async () => {
        const newAccount: CloudAccount = {
          id: "account-" + Date.now(),
          type: "dropbox",
          name: "New Account",
          credentials: {},
        };
        this.plugin.settings.accounts.push(newAccount);
        await this.plugin.saveSettings();
        this.plugin.initProviders();
        this.display();
      })
    );

    // ─── Sync Rules ───
    containerEl.createEl("h2", { text: "Sync Rules" });
    containerEl.createEl("p", {
      text: "Map a cloud account + cloud folder ↔ local vault folder.",
      cls: "setting-item-description",
    });

    for (const rule of this.plugin.settings.rules) {
      this.renderRule(containerEl, rule);
    }

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("+ Add Rule").onClick(async () => {
        const newRule: SyncRule = {
          id: "rule-" + Date.now(),
          accountId: this.plugin.settings.accounts[0]?.id || "",
          cloudFolder: "/",
          localFolder: "",
        };
        this.plugin.settings.rules.push(newRule);
        await this.plugin.saveSettings();
        this.display();
      })
    );

    // ─── Pipeline ───
    containerEl.createEl("h2", { text: "Sync Pipeline" });
    containerEl.createEl("p", {
      text: "Define the order of operations. Each step = Rule + Operation. Drag to reorder (or use ↑↓ buttons).",
      cls: "setting-item-description",
    });

    for (let i = 0; i < this.plugin.settings.pipeline.length; i++) {
      this.renderPipelineStep(containerEl, i);
    }

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("+ Add Step").onClick(async () => {
        const newStep: SyncStep = {
          ruleId: this.plugin.settings.rules[0]?.id || "",
          operation: "cloud-update",
        };
        this.plugin.settings.pipeline.push(newStep);
        await this.plugin.saveSettings();
        this.display();
      })
    );

    // ─── Quick Pipeline Generator ───
    containerEl.createEl("h2", { text: "Quick Generate Pipeline" });
    new Setting(containerEl)
      .setDesc(
        "Auto-generate a standard pipeline for all rules (update → add → delete, cloud-first)."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Generate Standard Pipeline")
          .setWarning()
          .onClick(async () => {
            const steps: SyncStep[] = [];
            const ops: SyncOpType[] = [
              "cloud-update",
              "local-update",
              "cloud-add",
              "local-add",
              "cloud-delete",
              "local-delete",
            ];
            for (const rule of this.plugin.settings.rules) {
              for (const op of ops) {
                steps.push({ ruleId: rule.id, operation: op });
              }
            }
            this.plugin.settings.pipeline = steps;
            await this.plugin.saveSettings();
            new Notice(`Generated ${steps.length} pipeline steps.`);
            this.display();
          })
      );

    // ─── Manual Sync ───
    containerEl.createEl("h2", { text: "Actions" });
    new Setting(containerEl)
      .setName("Run Sync Now")
      .setDesc("Execute the pipeline defined above.")
      .addButton((btn) =>
        btn
          .setButtonText("▶ Sync")
          .setCta()
          .onClick(async () => {
            await this.plugin.runSync();
          })
      );
  }

  private renderAccount(containerEl: HTMLElement, account: CloudAccount) {
    const s = new Setting(containerEl)
      .setName(account.name)
      .setDesc(`Type: ${account.type} | ID: ${account.id}`);

    // Name
    s.addText((text) =>
      text
        .setPlaceholder("Account name")
        .setValue(account.name)
        .onChange(async (val) => {
          account.name = val;
          await this.plugin.saveSettings();
        })
    );

    // Type dropdown
    s.addDropdown((dd) => {
      for (const ct of CLOUD_TYPES) dd.addOption(ct.value, ct.label);
      dd.setValue(account.type);
      dd.onChange(async (val) => {
        account.type = val as CloudProviderType;
        account.credentials = {};
        await this.plugin.saveSettings();
        this.plugin.initProviders();
        this.display();
      });
    });

    // Credentials button (opens a modal or inline fields)
    s.addButton((btn) =>
      btn.setButtonText("Credentials").onClick(() => {
        this.renderCredentials(containerEl, account);
      })
    );

    // Test connection
    s.addButton((btn) =>
      btn.setButtonText("Test").onClick(async () => {
        const provider = this.plugin.providers.get(account.id);
        if (!provider) {
          new Notice("Provider not initialized. Check credentials.");
          return;
        }
        const ok = await provider.testConnection();
        new Notice(ok ? "✓ Connected!" : "✗ Connection failed.");
      })
    );

    // Delete
    s.addButton((btn) =>
      btn
        .setButtonText("✕")
        .setWarning()
        .onClick(async () => {
          this.plugin.settings.accounts =
            this.plugin.settings.accounts.filter((a) => a.id !== account.id);
          // Remove rules and pipeline steps referencing this account
          this.plugin.settings.rules = this.plugin.settings.rules.filter(
            (r) => r.accountId !== account.id
          );
          const ruleIds = new Set(
            this.plugin.settings.rules.map((r) => r.id)
          );
          this.plugin.settings.pipeline =
            this.plugin.settings.pipeline.filter((s) =>
              ruleIds.has(s.ruleId)
            );
          await this.plugin.saveSettings();
          this.plugin.initProviders();
          this.display();
        })
    );
  }

  private renderCredentials(containerEl: HTMLElement, account: CloudAccount) {
    // Inline credential fields based on provider type
    const fields: { key: string; label: string; secret?: boolean }[] = [];
    switch (account.type) {
      case "dropbox":
        fields.push(
          { key: "appKey", label: "App Key" },
          { key: "accessToken", label: "Access Token", secret: true },
          { key: "refreshToken", label: "Refresh Token", secret: true }
        );
        break;
      case "onedrive":
        fields.push(
          { key: "clientId", label: "Client ID" },
          { key: "accessToken", label: "Access Token", secret: true },
          { key: "refreshToken", label: "Refresh Token", secret: true }
        );
        break;
      case "gdrive":
        fields.push(
          { key: "clientId", label: "Client ID" },
          { key: "clientSecret", label: "Client Secret", secret: true },
          { key: "accessToken", label: "Access Token", secret: true },
          { key: "refreshToken", label: "Refresh Token", secret: true }
        );
        break;
    }

    for (const field of fields) {
      new Setting(containerEl)
        .setName(`  ${field.label}`)
        .addText((text) => {
          text
            .setPlaceholder(field.label)
            .setValue(account.credentials[field.key] || "")
            .onChange(async (val) => {
              account.credentials[field.key] = val;
              await this.plugin.saveSettings();
              this.plugin.initProviders();
            });
          if (field.secret) text.inputEl.type = "password";
        });
    }
  }

  private renderRule(containerEl: HTMLElement, rule: SyncRule) {
    const account = this.plugin.settings.accounts.find(
      (a) => a.id === rule.accountId
    );
    const s = new Setting(containerEl)
      .setName(`${account?.name || "?"} : ${rule.cloudFolder} ↔ ${rule.localFolder || "(vault root)"}`)
      .setDesc(`Rule ID: ${rule.id}`);

    // Account dropdown
    s.addDropdown((dd) => {
      for (const a of this.plugin.settings.accounts) {
        dd.addOption(a.id, a.name);
      }
      dd.setValue(rule.accountId);
      dd.onChange(async (val) => {
        rule.accountId = val;
        await this.plugin.saveSettings();
        this.display();
      });
    });

    // Cloud folder
    s.addText((text) =>
      text
        .setPlaceholder("Cloud folder, e.g. /officefolder")
        .setValue(rule.cloudFolder)
        .onChange(async (val) => {
          rule.cloudFolder = val;
          await this.plugin.saveSettings();
        })
    );

    // Local folder
    s.addText((text) =>
      text
        .setPlaceholder("Local folder (relative to vault root)")
        .setValue(rule.localFolder)
        .onChange(async (val) => {
          rule.localFolder = val;
          await this.plugin.saveSettings();
        })
    );

    // Delete rule
    s.addButton((btn) =>
      btn
        .setButtonText("✕")
        .setWarning()
        .onClick(async () => {
          this.plugin.settings.rules =
            this.plugin.settings.rules.filter((r) => r.id !== rule.id);
          this.plugin.settings.pipeline =
            this.plugin.settings.pipeline.filter((s) => s.ruleId !== rule.id);
          delete this.plugin.settings.snapshots[rule.id];
          await this.plugin.saveSettings();
          this.display();
        })
    );
  }

  private renderPipelineStep(containerEl: HTMLElement, index: number) {
    const step = this.plugin.settings.pipeline[index];
    const rule = this.plugin.settings.rules.find((r) => r.id === step.ruleId);
    const account = rule
      ? this.plugin.settings.accounts.find((a) => a.id === rule.accountId)
      : null;

    const label = `#${index + 1}: ${account?.name || "?"} → ${step.operation}`;
    const s = new Setting(containerEl).setName(label);

    // Rule dropdown
    s.addDropdown((dd) => {
      for (const r of this.plugin.settings.rules) {
        const a = this.plugin.settings.accounts.find(
          (a) => a.id === r.accountId
        );
        dd.addOption(r.id, `${a?.name || "?"}: ${r.cloudFolder} ↔ ${r.localFolder}`);
      }
      dd.setValue(step.ruleId);
      dd.onChange(async (val) => {
        step.ruleId = val;
        await this.plugin.saveSettings();
        this.display();
      });
    });

    // Operation dropdown
    s.addDropdown((dd) => {
      for (const op of ALL_OPS) dd.addOption(op.value, op.label);
      dd.setValue(step.operation);
      dd.onChange(async (val) => {
        step.operation = val as SyncOpType;
        await this.plugin.saveSettings();
        this.display();
      });
    });

    // Move up
    s.addButton((btn) =>
      btn
        .setButtonText("↑")
        .setDisabled(index === 0)
        .onClick(async () => {
          const arr = this.plugin.settings.pipeline;
          [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
          await this.plugin.saveSettings();
          this.display();
        })
    );

    // Move down
    s.addButton((btn) =>
      btn
        .setButtonText("↓")
        .setDisabled(index === this.plugin.settings.pipeline.length - 1)
        .onClick(async () => {
          const arr = this.plugin.settings.pipeline;
          [arr[index], arr[index + 1]] = [arr[index + 1], arr[index]];
          await this.plugin.saveSettings();
          this.display();
        })
    );

    // Delete step
    s.addButton((btn) =>
      btn
        .setButtonText("✕")
        .setWarning()
        .onClick(async () => {
          this.plugin.settings.pipeline.splice(index, 1);
          await this.plugin.saveSettings();
          this.display();
        })
    );
  }
}
