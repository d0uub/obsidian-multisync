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
  private dragSourceIndex: number = -1;
  private expandedSteps = new Set<number>();
  private expandedRules = new Set<string>();

  constructor(app: App, plugin: MultiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /* ------------------------------------------------------------------ */
  /*  SVG helper factories                                               */
  /* ------------------------------------------------------------------ */

  private createRemoveIcon(parent: HTMLElement, onClick: () => Promise<void>): HTMLSpanElement {
    const span = parent.createSpan({ cls: "mobile-option-setting-item-remove-icon" });
    span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-minus-circle"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg>`;
    span.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return span;
  }

  private createDragIcon(parent: HTMLElement): HTMLSpanElement {
    const span = parent.createSpan({ cls: "mobile-option-setting-item-drag-icon" });
    span.setAttribute("draggable", "true");
    span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-grip-vertical"><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>`;
    return span;
  }

  /* ------------------------------------------------------------------ */
  /*  display()                                                          */
  /* ------------------------------------------------------------------ */

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Inject drag-and-drop styles once
    if (!containerEl.querySelector("style.multisync-dnd-styles")) {
      const style = containerEl.createEl("style");
      style.className = "multisync-dnd-styles";
      style.textContent = `
        .mobile-option-setting-item.is-dragging { opacity: 0.4; }
        .mobile-option-setting-item.drag-over { border-top: 2px solid var(--interactive-accent); }
        .mobile-option-setting-item-drag-icon { cursor: grab; }
        .mobile-option-setting-item-drag-icon:active { cursor: grabbing; }
        .mobile-option-setting-item-remove-icon { cursor: pointer; }
        .mobile-option-setting-item-name { flex: 1; }
        .multisync-step-edit, .multisync-rule-edit { padding: 0 0 8px 40px; }
      `;
    }

    // ─── Cloud Accounts ───
    containerEl.createEl("h2", { text: "Cloud Accounts" });
    for (const account of this.plugin.settings.accounts) {
      this.renderAccount(containerEl, account);
    }
    this.renderAddAccountRow(containerEl);

    // ─── Sync Rules ───
    containerEl.createEl("h2", { text: "Sync Rules" });
    for (const rule of this.plugin.settings.rules) {
      this.renderRule(containerEl, rule);
    }
    this.renderAddRuleRow(containerEl);

    // ─── Pipeline ───
    containerEl.createEl("h2", { text: "Sync Pipeline" });
    containerEl.createEl("p", {
      text: "Define the order of operations. Each step = Rule + Operation. Drag to reorder.",
      cls: "setting-item-description",
    });

    const pipelineContainer = containerEl.createDiv({ cls: "multisync-pipeline-list" });
    for (let i = 0; i < this.plugin.settings.pipeline.length; i++) {
      this.renderPipelineStep(pipelineContainer, i);
    }
    this.renderAddPipelineRow(pipelineContainer);

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

  /* ------------------------------------------------------------------ */
  /*  Accounts                                                           */
  /* ------------------------------------------------------------------ */

  private renderAccount(containerEl: HTMLElement, account: CloudAccount) {
    const isAuthed = !!(account.credentials.accessToken && account.credentials.refreshToken);
    const typeLabel = CLOUD_TYPES.find(c => c.value === account.type)?.label || account.type;

    const row = containerEl.createDiv({ cls: "mobile-option-setting-item" });

    // ── Remove icon (cascade delete) ──
    this.createRemoveIcon(row, async () => {
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
    });

    // ── Content area ──
    const content = row.createSpan({ cls: "mobile-option-setting-item-name" });

    if (isAuthed) {
      // ─── Compact view after auth ───
      const wrapper = content.createDiv({ cls: "multisync-account-row" });

      // Clickable label → editable on click
      const nameEl = wrapper.createEl("span", {
        text: `✓ ${account.name}`,
        cls: "multisync-account-name",
      });
      nameEl.style.cursor = "pointer";
      nameEl.style.fontWeight = "600";
      nameEl.style.marginRight = "8px";
      nameEl.title = "Click to rename";

      wrapper.createEl("span", {
        text: ` (${typeLabel})`,
        cls: "setting-item-description",
      });

      nameEl.addEventListener("click", () => {
        nameEl.contentEditable = "true";
        nameEl.textContent = account.name;
        nameEl.focus();
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
          this.display();
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

      const s = new Setting(wrapper).setDesc("");

      s.addButton((btn) =>
        btn.setButtonText("Re-authorize").onClick(async () => {
          await this.startOAuthFlow(account);
        })
      );

      s.addButton((btn) =>
        btn.setButtonText("Disconnect").setWarning().onClick(async () => {
          account.credentials = {};
          await this.plugin.saveSettings();
          this.plugin.initProviders();
          this.display();
        })
      );
    } else {
      // ─── Full setup view before auth ───
      const s = new Setting(content)
        .setName(account.name || "New Account")
        .setDesc(`${typeLabel} | Not connected`);

      s.addText((text) =>
        text
          .setPlaceholder("Account name")
          .setValue(account.name)
          .onChange(async (val) => {
            account.name = val;
            await this.plugin.saveSettings();
          })
      );

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

      s.addButton((btn) =>
        btn.setButtonText("Credentials").onClick(() => {
          this.renderCredentials(content, account);
        })
      );

      s.addButton((btn) =>
        btn.setButtonText("Authorize").setCta().onClick(async () => {
          await this.startOAuthFlow(account);
        })
      );
    }
  }

  private renderAddAccountRow(containerEl: HTMLElement) {
    const row = containerEl.createDiv({ cls: "mobile-option-setting-item" });
    const hiddenIcon = row.createSpan({ cls: "mobile-option-setting-item-remove-icon" });
    hiddenIcon.style.visibility = "hidden";
    hiddenIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-minus-circle"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg>`;

    const content = row.createSpan({ cls: "mobile-option-setting-item-name" });
    let newName = "New Account";
    let newType: CloudProviderType = "dropbox";

    const s = new Setting(content).setName("Add account");

    s.addText((text) =>
      text.setPlaceholder("Account name").setValue(newName).onChange((val) => {
        newName = val;
      })
    );

    s.addDropdown((dd) => {
      for (const ct of CLOUD_TYPES) dd.addOption(ct.value, ct.label);
      dd.setValue(newType);
      dd.onChange((val) => {
        newType = val as CloudProviderType;
      });
    });

    s.addButton((btn) =>
      btn.setButtonText("+").setCta().onClick(async () => {
        const newAccount: CloudAccount = {
          id: "account-" + Date.now(),
          type: newType,
          name: newName,
          credentials: {},
        };
        this.plugin.settings.accounts.push(newAccount);
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

  /* ------------------------------------------------------------------ */
  /*  Rules                                                              */
  /* ------------------------------------------------------------------ */

  private renderRule(containerEl: HTMLElement, rule: SyncRule) {
    const account = this.plugin.settings.accounts.find(
      (a) => a.id === rule.accountId
    );
    const localLabel = rule.localFolder || "(entire vault)";
    const cloudLabel = rule.cloudFolder || "(drive root)";

    const row = containerEl.createDiv({ cls: "mobile-option-setting-item" });

    // ── Remove icon (cascade delete) ──
    this.createRemoveIcon(row, async () => {
      this.plugin.settings.rules =
        this.plugin.settings.rules.filter((r) => r.id !== rule.id);
      this.plugin.settings.pipeline =
        this.plugin.settings.pipeline.filter((s) => s.ruleId !== rule.id);
      delete this.plugin.settings.snapshots[rule.id];
      await this.plugin.saveSettings();
      this.display();
    });

    // ── Clickable name ──
    const nameSpan = row.createSpan({ cls: "mobile-option-setting-item-name" });
    nameSpan.textContent = `${account?.name || "?"}: ${cloudLabel} ↔ ${localLabel}`;
    nameSpan.style.cursor = "pointer";

    // ── Expand / collapse edit area ──
    const editDiv = containerEl.createDiv({ cls: "multisync-rule-edit" });
    editDiv.style.display = this.expandedRules.has(rule.id) ? "" : "none";

    nameSpan.addEventListener("click", () => {
      if (this.expandedRules.has(rule.id)) {
        this.expandedRules.delete(rule.id);
        editDiv.style.display = "none";
      } else {
        this.expandedRules.add(rule.id);
        editDiv.style.display = "";
      }
    });

    // Account dropdown
    new Setting(editDiv).setName("Account").addDropdown((dd) => {
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
    new Setting(editDiv).setName("Cloud folder").addText((text) => {
      text
        .setPlaceholder("Cloud folder, e.g. Documents/notes")
        .setValue(rule.cloudFolder)
        .onChange(async (val) => {
          rule.cloudFolder = val.replace(/^\/+/, "");
          await this.plugin.saveSettings();
        });
    });

    // Local folder (with suggest dropdown)
    new Setting(editDiv).setName("Local folder").addSearch((search) => {
      search
        .setPlaceholder("Type to search vault folders...")
        .setValue(rule.localFolder || "(entire vault)")
        .onChange(async (val) => {
          rule.localFolder = val === "(entire vault)" ? "" : val.replace(/^\/+/, "");
          await this.plugin.saveSettings();
        });
      new FolderSuggest(this.app, search.inputEl);
    });
  }

  private renderAddRuleRow(containerEl: HTMLElement) {
    const row = containerEl.createDiv({ cls: "mobile-option-setting-item" });
    const hiddenIcon = row.createSpan({ cls: "mobile-option-setting-item-remove-icon" });
    hiddenIcon.style.visibility = "hidden";
    hiddenIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-minus-circle"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg>`;

    const content = row.createSpan({ cls: "mobile-option-setting-item-name" });

    let newAccountId = this.plugin.settings.accounts[0]?.id || "";
    let newCloudFolder = "";
    let newLocalFolder = "";

    const s = new Setting(content).setName("Add rule");

    s.addDropdown((dd) => {
      for (const a of this.plugin.settings.accounts) {
        dd.addOption(a.id, a.name);
      }
      if (newAccountId) dd.setValue(newAccountId);
      dd.onChange((val) => {
        newAccountId = val;
      });
    });

    s.addText((text) =>
      text.setPlaceholder("Cloud folder").onChange((val) => {
        newCloudFolder = val.replace(/^\/+/, "");
      })
    );

    s.addSearch((search) => {
      search
        .setPlaceholder("Local folder")
        .onChange((val) => {
          newLocalFolder = val === "(entire vault)" ? "" : val.replace(/^\/+/, "");
        });
      new FolderSuggest(this.app, search.inputEl);
    });

    s.addButton((btn) =>
      btn.setButtonText("+").setCta().onClick(async () => {
        const newRule: SyncRule = {
          id: "rule-" + Date.now(),
          accountId: newAccountId,
          cloudFolder: newCloudFolder,
          localFolder: newLocalFolder,
        };
        this.plugin.settings.rules.push(newRule);
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Pipeline                                                           */
  /* ------------------------------------------------------------------ */

  private renderPipelineStep(pipelineContainer: HTMLElement, index: number) {
    const step = this.plugin.settings.pipeline[index];
    const rule = this.plugin.settings.rules.find((r) => r.id === step.ruleId);
    const account = rule
      ? this.plugin.settings.accounts.find((a) => a.id === rule.accountId)
      : null;
    const opLabel = ALL_OPS.find((o) => o.value === step.operation)?.label || step.operation;

    const row = pipelineContainer.createDiv({ cls: "mobile-option-setting-item" });

    // ── Remove icon ──
    this.createRemoveIcon(row, async () => {
      this.plugin.settings.pipeline.splice(index, 1);
      this.expandedSteps.clear();
      await this.plugin.saveSettings();
      this.display();
    });

    // ── Step number icon ──
    const numSpan = row.createSpan({ cls: "mobile-option-setting-item-option-icon" });
    numSpan.textContent = `#${index + 1}`;

    // ── Step label (clickable) ──
    const nameSpan = row.createSpan({ cls: "mobile-option-setting-item-name" });
    nameSpan.textContent = `${account?.name || "?"} → ${opLabel}`;
    nameSpan.style.cursor = "pointer";

    // ── Drag handle ──
    const handle = this.createDragIcon(row);

    // Drag-and-drop events on the handle
    handle.addEventListener("dragstart", (e) => {
      this.dragSourceIndex = index;
      e.dataTransfer?.setData("text/plain", String(index));
      row.classList.add("is-dragging");
    });
    handle.addEventListener("dragend", () => {
      row.classList.remove("is-dragging");
      pipelineContainer.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    });

    // Drop target events on the row
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      pipelineContainer.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drag-over");
    });
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const from = this.dragSourceIndex;
      const to = index;
      if (from !== to && from >= 0) {
        const arr = this.plugin.settings.pipeline;
        const [moved] = arr.splice(from, 1);
        arr.splice(to, 0, moved);
        this.expandedSteps.clear();
        await this.plugin.saveSettings();
        this.display();
      }
    });

    // ── Expand / collapse edit area ──
    const editDiv = pipelineContainer.createDiv({ cls: "multisync-step-edit" });
    editDiv.style.display = this.expandedSteps.has(index) ? "" : "none";

    nameSpan.addEventListener("click", () => {
      if (this.expandedSteps.has(index)) {
        this.expandedSteps.delete(index);
        editDiv.style.display = "none";
      } else {
        this.expandedSteps.add(index);
        editDiv.style.display = "";
      }
    });

    // Rule dropdown
    new Setting(editDiv).setName("Rule").addDropdown((dd) => {
      for (const r of this.plugin.settings.rules) {
        const a = this.plugin.settings.accounts.find(
          (acc) => acc.id === r.accountId
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
    new Setting(editDiv).setName("Operation").addDropdown((dd) => {
      for (const op of ALL_OPS) dd.addOption(op.value, op.label);
      dd.setValue(step.operation);
      dd.onChange(async (val) => {
        step.operation = val as SyncOpType;
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }

  private renderAddPipelineRow(pipelineContainer: HTMLElement) {
    const row = pipelineContainer.createDiv({ cls: "mobile-option-setting-item" });
    const hiddenIcon = row.createSpan({ cls: "mobile-option-setting-item-remove-icon" });
    hiddenIcon.style.visibility = "hidden";
    hiddenIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-minus-circle"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg>`;

    const content = row.createSpan({ cls: "mobile-option-setting-item-name" });

    let newRuleId = this.plugin.settings.rules[0]?.id || "";
    let newOp: SyncOpType = "cloud-update";

    const s = new Setting(content).setName("Add step");

    s.addDropdown((dd) => {
      for (const r of this.plugin.settings.rules) {
        const a = this.plugin.settings.accounts.find(
          (acc) => acc.id === r.accountId
        );
        dd.addOption(r.id, `${a?.name || "?"}: ${r.cloudFolder} ↔ ${r.localFolder}`);
      }
      if (newRuleId) dd.setValue(newRuleId);
      dd.onChange((val) => {
        newRuleId = val;
      });
    });

    s.addDropdown((dd) => {
      for (const op of ALL_OPS) dd.addOption(op.value, op.label);
      dd.setValue(newOp);
      dd.onChange((val) => {
        newOp = val as SyncOpType;
      });
    });

    s.addButton((btn) =>
      btn.setButtonText("+").setCta().onClick(async () => {
        const newStep: SyncStep = {
          ruleId: newRuleId,
          operation: newOp,
        };
        this.plugin.settings.pipeline.push(newStep);
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
