import {
  App,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
} from "obsidian";
import type MultiSyncPlugin from "./main";
import type {
  CloudAccount,
  CloudProviderType,
  SyncRule,
  SyncStep,
  SyncOpType,
} from "./types";
import {
  needsManualPaste,
  getDropboxAuthUrl,
  getOneDriveAuthUrl,
  getGDriveAuthUrl,
  exchangeDropboxCode,
  exchangeOneDriveCode,
  exchangeGDriveCode,
} from "./oauth";
import { FolderSuggest } from "./ui/FolderSuggest";

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
    this.renderSectionHeader(containerEl, "Cloud Accounts", "+ Add", async () => {
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
    });

    for (const account of this.plugin.settings.accounts) {
      this.renderAccount(containerEl, account);
    }

    // ─── Sync Rules ───
    this.renderSectionHeader(containerEl, "Sync Rules", "+ Add", async () => {
      const newRule: SyncRule = {
        id: "rule-" + Date.now(),
        accountId: this.plugin.settings.accounts[0]?.id || "",
        cloudFolder: "",
        localFolder: "",
      };
      this.plugin.settings.rules.push(newRule);
      await this.plugin.saveSettings();
      this.display();
    });

    for (const rule of this.plugin.settings.rules) {
      this.renderRule(containerEl, rule);
    }

    // ─── Pipeline ───
    this.renderSectionHeader(containerEl, "Sync Pipeline", "+ Add Step", async () => {
      const newStep: SyncStep = {
        ruleId: this.plugin.settings.rules[0]?.id || "",
        operation: "cloud-update",
      };
      this.plugin.settings.pipeline.push(newStep);
      await this.plugin.saveSettings();
      this.display();
    });

    containerEl.createEl("p", {
      text: "Define the order of operations. Each step = Rule + Operation.",
      cls: "setting-item-description",
    });

    for (let i = 0; i < this.plugin.settings.pipeline.length; i++) {
      this.renderPipelineStep(containerEl, i);
    }

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
      )
      .addButton((btn) =>
        btn
          .setButtonText("👁 Dry Run")
          .onClick(async () => {
            await this.plugin.runSync(true);
          })
      );
  }

  /** Render section header with an inline add button aligned right */
  private renderSectionHeader(
    containerEl: HTMLElement,
    title: string,
    buttonText: string,
    onClick: () => Promise<void>
  ) {
    const header = containerEl.createDiv({ cls: "multisync-section-header" });
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.marginTop = "1.5em";
    header.style.marginBottom = "0.5em";
    header.createEl("h2", { text: title });
    const btn = header.createEl("button", { text: buttonText, cls: "mod-cta" });
    btn.style.fontSize = "0.85em";
    btn.style.padding = "4px 12px";
    btn.addEventListener("click", onClick);
  }

  private renderAccount(containerEl: HTMLElement, account: CloudAccount) {
    const isAuthed = !!(account.credentials.accessToken && account.credentials.refreshToken);
    const typeLabel = CLOUD_TYPES.find(c => c.value === account.type)?.label || account.type;

    if (isAuthed) {
      // ─── Compact view after auth ───
      const wrapper = containerEl.createDiv({ cls: "multisync-account-row" });
      
      // Clickable label → editable on click
      const nameEl = wrapper.createEl("span", {
        text: `✓ ${account.name}`,
        cls: "multisync-account-name",
      });
      nameEl.style.cursor = "pointer";
      nameEl.style.fontWeight = "600";
      nameEl.style.marginRight = "8px";
      nameEl.title = "Click to rename";

      const descEl = wrapper.createEl("span", {
        text: ` (${typeLabel})`,
        cls: "setting-item-description",
      });

      nameEl.addEventListener("click", () => {
        nameEl.contentEditable = "true";
        nameEl.textContent = account.name;
        nameEl.focus();
        // Select all text
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });

      const saveName = async () => {
        nameEl.contentEditable = "false";
        const newName = (nameEl.textContent || "").trim();
        if (newName && newName !== account.name) {
          account.name = newName;
          await this.plugin.saveSettings();
          this.display(); // refresh to update rule/pipeline labels
        } else {
          nameEl.textContent = `✓ ${account.name}`;
        }
      };

      nameEl.addEventListener("blur", saveName);
      nameEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameEl.blur();
        } else if (e.key === "Escape") {
          nameEl.textContent = `✓ ${account.name}`;
          nameEl.contentEditable = "false";
        }
      });

      const s = new Setting(wrapper)
        .setDesc("");

      // Re-authorize
      s.addButton((btn) =>
        btn.setButtonText("Re-authorize").onClick(async () => {
          await this.startOAuthFlow(account);
        })
      );

      // Disconnect
      s.addButton((btn) =>
        btn.setButtonText("Disconnect").setWarning().onClick(async () => {
          account.credentials = {};
          await this.plugin.saveSettings();
          this.plugin.initProviders();
          this.display();
        })
      );

      // Delete account
      s.addButton((btn) =>
        btn.setButtonText("✕").setWarning().onClick(async () => {
          this.plugin.settings.accounts =
            this.plugin.settings.accounts.filter((a) => a.id !== account.id);
          this.plugin.settings.rules = this.plugin.settings.rules.filter(
            (r) => r.accountId !== account.id
          );
          const ruleIds = new Set(this.plugin.settings.rules.map((r) => r.id));
          this.plugin.settings.pipeline =
            this.plugin.settings.pipeline.filter((s) => ruleIds.has(s.ruleId));
          await this.plugin.saveSettings();
          this.plugin.initProviders();
          this.display();
        })
      );
    } else {
      // ─── Full setup view before auth ───
      const s = new Setting(containerEl)
        .setName(account.name || "New Account")
        .setDesc(`${typeLabel} | Not connected`);

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

      // Credentials (for manual setup or entering app key/client ID)
      s.addButton((btn) =>
        btn.setButtonText("Credentials").onClick(() => {
          this.renderCredentials(containerEl, account);
        })
      );

      // Authorize
      s.addButton((btn) =>
        btn.setButtonText("Authorize").setCta().onClick(async () => {
          await this.startOAuthFlow(account);
        })
      );

      // Delete
      s.addButton((btn) =>
        btn.setButtonText("✕").setWarning().onClick(async () => {
          this.plugin.settings.accounts =
            this.plugin.settings.accounts.filter((a) => a.id !== account.id);
          this.plugin.settings.rules = this.plugin.settings.rules.filter(
            (r) => r.accountId !== account.id
          );
          const ruleIds = new Set(this.plugin.settings.rules.map((r) => r.id));
          this.plugin.settings.pipeline =
            this.plugin.settings.pipeline.filter((s) => ruleIds.has(s.ruleId));
          await this.plugin.saveSettings();
          this.plugin.initProviders();
          this.display();
        })
      );
    }
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
    const localLabel = rule.localFolder || "(entire vault)";
    const cloudLabel = rule.cloudFolder || "(drive root)";
    const s = new Setting(containerEl)
      .setName(`${account?.name || "?"} : ${cloudLabel} ↔ ${localLabel}`)
      .setDesc(`Rule: ${rule.id}`);

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
    s.addText((text) => {
      text
        .setPlaceholder("Cloud folder, e.g. Documents/notes")
        .setValue(rule.cloudFolder)
        .onChange(async (val) => {
          // Auto-strip leading slash for UX
          rule.cloudFolder = val.replace(/^\/+/, "");
          await this.plugin.saveSettings();
        });
    });

    // Local folder (with suggest dropdown)
    s.addSearch((search) => {
      search
        .setPlaceholder("Type to search vault folders...")
        .setValue(rule.localFolder || "(entire vault)")
        .onChange(async (val) => {
          rule.localFolder = val === "(entire vault)" ? "" : val.replace(/^\/+/, "");
          await this.plugin.saveSettings();
        });
      new FolderSuggest(this.app, search.inputEl);
    });

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

  private async startOAuthFlow(account: CloudAccount) {
    const missing = this.getMissingCredFields(account);
    if (missing.length > 0) {
      new Notice(`Set ${missing.join(", ")} in credentials first.`);
      return;
    }

    const manual = needsManualPaste();
    let authUrl: string;
    let verifier: string;

    try {
      switch (account.type) {
        case "dropbox": {
          const r = await getDropboxAuthUrl(account.credentials.appKey, manual);
          authUrl = r.authUrl;
          verifier = r.verifier;
          break;
        }
        case "onedrive": {
          const r = await getOneDriveAuthUrl(account.credentials.clientId, manual);
          authUrl = r.authUrl;
          verifier = r.verifier;
          break;
        }
        case "gdrive": {
          const r = await getGDriveAuthUrl(account.credentials.clientId, manual);
          authUrl = r.authUrl;
          verifier = r.verifier;
          break;
        }
        default:
          new Notice("Unknown provider type");
          return;
      }
    } catch (e: any) {
      new Notice(`OAuth error: ${e?.message || e}`);
      return;
    }

    this.plugin.oauth2Info = { verifier, accountId: account.id, manual };

    if (manual) {
      new AuthCodeModal(this.app, this.plugin, account, verifier, authUrl).open();
    } else {
      window.open(authUrl);
      new Notice("Browser opened for authorization. Return here after granting access.");
    }
  }

  private getMissingCredFields(account: CloudAccount): string[] {
    const missing: string[] = [];
    switch (account.type) {
      case "dropbox":
        if (!account.credentials.appKey) missing.push("App Key");
        break;
      case "onedrive":
        if (!account.credentials.clientId) missing.push("Client ID");
        break;
      case "gdrive":
        if (!account.credentials.clientId) missing.push("Client ID");
        if (!account.credentials.clientSecret) missing.push("Client Secret");
        break;
    }
    return missing;
  }
}

class AuthCodeModal extends Modal {
  private plugin: MultiSyncPlugin;
  private account: CloudAccount;
  private verifier: string;
  private authUrl: string;

  constructor(
    app: App,
    plugin: MultiSyncPlugin,
    account: CloudAccount,
    verifier: string,
    authUrl: string
  ) {
    super(app);
    this.plugin = plugin;
    this.account = account;
    this.verifier = verifier;
    this.authUrl = authUrl;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Authorize ${this.account.name}` });
    contentEl.createEl("p", { text: "1. Copy the auth URL and open in browser." });
    contentEl.createEl("p", { text: "2. Grant access, then copy the authorization code." });
    contentEl.createEl("p", { text: "3. Paste the code below and submit." });

    new Setting(contentEl)
      .setName("Auth URL")
      .addButton((btn) =>
        btn.setButtonText("Copy URL").setCta().onClick(async () => {
          await navigator.clipboard.writeText(this.authUrl);
          new Notice("Auth URL copied to clipboard!");
        })
      );

    let codeValue = "";
    new Setting(contentEl)
      .setName("Authorization Code")
      .addText((text) =>
        text.setPlaceholder("Paste code here").onChange((val) => {
          codeValue = val.trim();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Submit").setCta().onClick(async () => {
          if (!codeValue) {
            new Notice("Please paste the authorization code.");
            return;
          }
          try {
            await this.exchangeCode(codeValue);
            new Notice(`${this.account.name} connected!`);
            this.close();
          } catch (e: any) {
            new Notice(`Auth failed: ${e?.message || e}`);
          }
        })
      );
  }

  private async exchangeCode(code: string) {
    const creds = this.account.credentials;
    switch (this.account.type) {
      case "dropbox": {
        const r = await exchangeDropboxCode(creds.appKey, code, this.verifier, true);
        creds.accessToken = r.access_token;
        creds.refreshToken = r.refresh_token;
        creds.tokenExpiry = String(Date.now() + r.expires_in * 1000 - 10000);
        break;
      }
      case "onedrive": {
        const r = await exchangeOneDriveCode(creds.clientId, code, this.verifier, true);
        creds.accessToken = r.access_token;
        creds.refreshToken = r.refresh_token;
        creds.tokenExpiry = String(Date.now() + r.expires_in * 1000 - 120000);
        break;
      }
      case "gdrive": {
        const r = await exchangeGDriveCode(creds.clientId, creds.clientSecret, code, this.verifier, true);
        creds.accessToken = r.access_token;
        creds.refreshToken = r.refresh_token;
        creds.tokenExpiry = String(Date.now() + r.expires_in * 1000 - 120000);
        break;
      }
    }
    await this.plugin.saveSettings();
    this.plugin.initProviders();
  }

  onClose() {
    this.contentEl.empty();
    this.plugin.oauth2Info = {};
  }
}
