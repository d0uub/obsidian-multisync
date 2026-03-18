import {
  App,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  setIcon,
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

/** Branded SVG icons for cloud providers (from Simple Icons, CC0) */
const PROVIDER_SVG: Record<CloudProviderType, string> = {
  dropbox: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z"/></svg>',
  onedrive: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.453 9.95q.961.058 1.787.468.826.41 1.442 1.066.615.657.966 1.512.352.856.352 1.816 0 1.008-.387 1.893-.386.885-1.049 1.547-.662.662-1.546 1.049-.885.387-1.893.387H6q-1.242 0-2.332-.475-1.09-.475-1.904-1.29-.815-.814-1.29-1.903Q0 14.93 0 13.688q0-.985.31-1.887.311-.903.862-1.658.55-.756 1.324-1.325.774-.568 1.711-.861.434-.129.85-.187.416-.06.861-.082h.012q.515-.786 1.207-1.413.691-.627 1.5-1.066.808-.44 1.705-.668.896-.229 1.845-.229 1.278 0 2.456.417 1.177.416 2.144 1.16.967.744 1.658 1.78.692 1.038 1.008 2.28zm-7.265-4.137q-1.325 0-2.52.544-1.195.545-2.04 1.565.446.117.85.299.405.181.792.416l4.78 2.86 2.731-1.15q.27-.117.545-.204.276-.088.58-.147-.293-.937-.855-1.705-.563-.768-1.319-1.318-.755-.551-1.658-.856-.902-.304-1.886-.304zM2.414 16.395l9.914-4.184-3.832-2.297q-.586-.351-1.23-.539-.645-.188-1.325-.188-.914 0-1.722.364-.809.363-1.412.978-.604.616-.955 1.436-.352.82-.352 1.723 0 .703.234 1.423.235.721.68 1.284zm16.711 1.793q.563 0 1.078-.176.516-.176.961-.516l-7.23-4.324-10.301 4.336q.527.328 1.13.504.604.175 1.237.175zm3.012-1.852q.363-.727.363-1.523 0-.774-.293-1.407t-.791-1.072q-.498-.44-1.166-.68-.668-.24-1.406-.24-.422 0-.838.1t-.815.252q-.398.152-.785.334-.386.181-.761.345Z"/></svg>',
  gdrive: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z"/></svg>',
};

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
        .setting-group { margin-bottom: 1em; }
      `;
    }

    // ─── Cloud Accounts ───
    const accountGroup = containerEl.createDiv({ cls: "setting-group" });
    new Setting(accountGroup).setName("Cloud Accounts").setHeading();
    const accountItems = accountGroup.createDiv({ cls: "setting-items" });
    for (const account of this.plugin.settings.accounts) {
      this.renderAccount(accountItems, account);
    }
    this.renderAddAccountRow(accountItems);

    // ─── Sync Rules ───
    const rulesGroup = containerEl.createDiv({ cls: "setting-group" });
    new Setting(rulesGroup).setName("Cloud Drive Mapping").setHeading();
    const rulesListEl = rulesGroup.createDiv({ cls: "setting-items" });
    for (let ri = 0; ri < this.plugin.settings.rules.length; ri++) {
      this.renderRule(rulesListEl, this.plugin.settings.rules[ri], ri);
    }
    this.renderAddRuleRow(rulesListEl);

    // ─── Sync Mode ───
    const syncGroup = containerEl.createDiv({ cls: "setting-group" });
    new Setting(syncGroup).setName("Sync Mode").setHeading();

    const syncItems = syncGroup.createDiv({ cls: "setting-items multisync-pipeline-list" });

    new Setting(syncItems)
      .setName("Advanced Mode")
      .setDesc("Fully customize sync operations and ordering.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.advancedMode).onChange(async (val) => {
          this.plugin.settings.advancedMode = val;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(syncItems)
      .setName("Concurrent transfers")
      .setDesc(`${this.plugin.settings.concurrency || 4} simultaneous file operations`)
      .addSlider((slider) =>
        slider.setLimits(1, 10, 1)
          .setValue(this.plugin.settings.concurrency || 4)
          .onChange(async (val) => {
            this.plugin.settings.concurrency = val;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.advancedMode) {
      for (let i = 0; i < this.plugin.settings.pipeline.length; i++) {
        this.renderPipelineStep(syncItems, i);
      }
      this.renderAddPipelineRow(syncItems);
    }

    // ─── Manual Sync ───
    new Setting(containerEl).setName("Actions").setHeading();
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

    // ── Remove icon ──
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

    // ── Vendor icon ──
    const vendorIcon = row.createSpan({ cls: "mobile-option-setting-item-option-icon" });
    vendorIcon.innerHTML = PROVIDER_SVG[account.type] || '';

    // ── Inline-editable name ──
    const nameSpan = row.createSpan({ cls: "mobile-option-setting-item-name" });
    nameSpan.textContent = account.name;
    nameSpan.style.cursor = "pointer";
    nameSpan.title = "Click to rename";

    let accountEditing = false;

    nameSpan.addEventListener("click", () => {
      if (accountEditing) return;
      accountEditing = true;
      nameSpan.style.display = "none";

      const inputWrapper = row.insertBefore(document.createElement("span"), nameSpan.nextSibling);
      inputWrapper.className = "mobile-option-setting-item-name";
      const textInput = document.createElement("input");
      textInput.type = "text";
      textInput.placeholder = "Account Name";
      textInput.value = account.name;
      textInput.style.cssText = "width:100%;font-size:inherit;";
      inputWrapper.appendChild(textInput);
      textInput.focus();
      textInput.select();

      const finish = async () => {
        accountEditing = false;
        const val = textInput.value.trim();
        if (val && val !== account.name) {
          account.name = val;
          await this.plugin.saveSettings();
          this.display();
          return;
        }
        nameSpan.textContent = account.name;
        inputWrapper.remove();
        nameSpan.style.display = "";
      };

      textInput.addEventListener("blur", finish);
      textInput.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); textInput.blur(); }
        else if (e.key === "Escape") { textInput.value = account.name; textInput.blur(); }
      });
    });

    // ── Action icons ──
    if (isAuthed) {
      // Test connection
      this.createClickableIcon(row, "activity", "Test connection", async () => {
        new Notice(`${account.name}: Testing…`);
        const provider = this.plugin.providers.get(account.id);
        if (!provider) {
          new Notice(`${account.name}: Provider not initialized`);
          return;
        }
        try {
          await provider.listFiles("");
          new Notice(`${account.name}: ✓ Connected`);
        } catch (e: any) {
          new Notice(`${account.name}: ✗ ${e?.message || e}`);
        }
      });

      this.createClickableIcon(row, "refresh-cw", "Re-authorize", async () => {
        await this.startOAuthFlow(account);
      });
      this.createClickableIcon(row, "x-circle", "Disconnect", async () => {
        account.credentials = {};
        await this.plugin.saveSettings();
        this.plugin.initProviders();
        this.display();
      });
    } else {
      this.createClickableIcon(row, "log-in", "Authorize", async () => {
        await this.startOAuthFlow(account);
      });
    }
  }

  private createClickableIcon(parent: HTMLElement, iconId: string, tooltip: string, onClick: () => void): HTMLSpanElement {
    const span = parent.createSpan({ cls: "clickable-icon", attr: { "aria-label": tooltip } });
    setIcon(span, iconId);
    span.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return span;
  }

  private renderAddAccountRow(containerEl: HTMLElement) {
    let newName = "";
    let newType: CloudProviderType = "dropbox";

    const s = new Setting(containerEl).setName("Add account");

    s.addText((text) =>
      text.setPlaceholder("Account Name").setValue(newName).onChange((val) => {
        newName = val;
      })
    );

    // Vendor icon next to dropdown
    const iconSpan = document.createElement("span");
    iconSpan.className = "multisync-inline-icon";
    iconSpan.style.cssText = "display:inline-flex;vertical-align:middle;margin-right:4px;";
    iconSpan.innerHTML = PROVIDER_SVG[newType] || '';

    s.addDropdown((dd) => {
      dd.selectEl.parentElement?.insertBefore(iconSpan, dd.selectEl);
      for (const ct of CLOUD_TYPES) dd.addOption(ct.value, ct.label);
      dd.setValue(newType);
      dd.onChange((val) => {
        newType = val as CloudProviderType;
        iconSpan.innerHTML = PROVIDER_SVG[newType] || '';
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

  private renderRule(containerEl: HTMLElement, rule: SyncRule, index: number) {
    const account = this.plugin.settings.accounts.find(
      (a) => a.id === rule.accountId
    );

    const row = containerEl.createDiv({ cls: "mobile-option-setting-item" });

    // ── Remove icon (cascade delete) ──
    this.createRemoveIcon(row, async () => {
      this.plugin.settings.rules =
        this.plugin.settings.rules.filter((r) => r.id !== rule.id);
      this.plugin.settings.pipeline =
        this.plugin.settings.pipeline.filter((s) => s.ruleId !== rule.id);
      delete this.plugin.settings.pendingCloudDeletes[rule.id];
      await this.plugin.saveSettings();
      this.display();
    });

    // ── Vendor icon ──
    if (account) {
      const vendorIcon = row.createSpan({ cls: "mobile-option-setting-item-option-icon" });
      vendorIcon.innerHTML = PROVIDER_SVG[account.type] || '';
    }

    // ── Name area with inline-editable paths ──
    const nameSpan = row.createSpan({ cls: "mobile-option-setting-item-name" });

    // Account selector (inline dropdown)
    const accountSelect = nameSpan.createEl("select", { cls: "dropdown" });
    accountSelect.style.cssText = "border:none;background:transparent;font-weight:600;font-size:inherit;color:inherit;padding:0;margin-right:4px;cursor:pointer;";
    for (const a of this.plugin.settings.accounts) {
      const opt = accountSelect.createEl("option", { text: a.name, value: a.id });
      if (a.id === rule.accountId) opt.selected = true;
    }
    accountSelect.addEventListener("change", async () => {
      rule.accountId = accountSelect.value;
      await this.plugin.saveSettings();
      this.display();
    });

    nameSpan.createEl("span", { text: ": " });

    // Cloud folder (click-to-edit with input box)
    const cloudLabel = nameSpan.createEl("span", { text: rule.cloudFolder || "(drive root)" });
    cloudLabel.style.cursor = "pointer";
    cloudLabel.title = "Click to edit";

    let cloudEditing = false;

    cloudLabel.addEventListener("click", () => {
      if (cloudEditing) return;
      cloudEditing = true;
      cloudLabel.style.display = "none";

      const inputWrapper = nameSpan.insertBefore(document.createElement("span"), cloudLabel.nextSibling);
      inputWrapper.style.display = "inline-block";
      inputWrapper.style.verticalAlign = "middle";

      const textInput = document.createElement("input");
      textInput.type = "text";
      textInput.placeholder = "Cloud folder";
      textInput.value = rule.cloudFolder || "";
      textInput.style.cssText = "width:120px;font-size:inherit;";
      inputWrapper.appendChild(textInput);
      textInput.focus();

      const finish = async () => {
        cloudEditing = false;
        const val = textInput.value.trim();
        rule.cloudFolder = val.replace(/^\/+/, "");
        cloudLabel.textContent = rule.cloudFolder || "(drive root)";
        inputWrapper.remove();
        cloudLabel.style.display = "";
        await this.plugin.saveSettings();
      };

      textInput.addEventListener("blur", finish);
      textInput.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); textInput.blur(); }
        else if (e.key === "Escape") { textInput.value = rule.cloudFolder; textInput.blur(); }
      });
    });

    nameSpan.createEl("span", { text: " ↔ " });

    // Local folder (click-to-edit with FolderSuggest)
    const folderIcon = nameSpan.createSpan();
    setIcon(folderIcon, "folder");
    folderIcon.style.display = "inline-flex";
    folderIcon.style.verticalAlign = "middle";
    folderIcon.style.marginRight = "2px";

    const localLabel = nameSpan.createEl("span", { text: rule.localFolder || "(entire vault)" });
    localLabel.style.cursor = "pointer";
    localLabel.title = "Click to edit";

    let localEditing = false;

    localLabel.addEventListener("click", () => {
      if (localEditing) return;
      localEditing = true;
      localLabel.style.display = "none";

      const searchWrapper = nameSpan.createDiv({ cls: "search-input-container" });
      searchWrapper.style.display = "inline-block";
      searchWrapper.style.width = "140px";
      searchWrapper.style.verticalAlign = "middle";

      const searchInput = searchWrapper.createEl("input", {
        type: "search",
        attr: { placeholder: "Type to search vault folders...", enterkeyhint: "done" },
      });
      searchInput.value = rule.localFolder || "";
      searchInput.focus();

      new FolderSuggest(this.app, searchInput);

      const finish = async () => {
        localEditing = false;
        const val = searchInput.value.trim();
        rule.localFolder = val === "(entire vault)" ? "" : val.replace(/^\/+/, "");
        localLabel.textContent = rule.localFolder || "(entire vault)";
        searchWrapper.remove();
        localLabel.style.display = "";
        await this.plugin.saveSettings();
      };

      searchInput.addEventListener("blur", () => setTimeout(finish, 150));
      searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); searchInput.blur(); }
        else if (e.key === "Escape") { searchInput.value = rule.localFolder; searchInput.blur(); }
      });
    });

    // ── Drag handle ──
    const handle = this.createDragIcon(row);

    handle.addEventListener("dragstart", (e) => {
      this.dragSourceIndex = index;
      e.dataTransfer?.setData("text/plain", String(index));
      row.classList.add("is-dragging");
    });
    handle.addEventListener("dragend", () => {
      row.classList.remove("is-dragging");
      containerEl.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    });

    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      containerEl.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
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
        const arr = this.plugin.settings.rules;
        const [moved] = arr.splice(from, 1);
        arr.splice(to, 0, moved);
        await this.plugin.saveSettings();
        this.display();
      }
    });
  }

  private renderAddRuleRow(containerEl: HTMLElement) {
    let newAccountId = this.plugin.settings.accounts[0]?.id || "";
    let newCloudFolder = "";
    let newLocalFolder = "";

    const s = new Setting(containerEl).setName("Add Mapping");

    const firstAccount = this.plugin.settings.accounts[0];
    const ruleIconSpan = document.createElement("span");
    ruleIconSpan.className = "multisync-inline-icon";
    ruleIconSpan.style.cssText = "display:inline-flex;vertical-align:middle;margin-right:4px;";
    if (firstAccount) ruleIconSpan.innerHTML = PROVIDER_SVG[firstAccount.type] || '';

    s.addDropdown((dd) => {
      dd.selectEl.parentElement?.insertBefore(ruleIconSpan, dd.selectEl);
      for (const a of this.plugin.settings.accounts) {
        dd.addOption(a.id, a.name);
      }
      if (newAccountId) dd.setValue(newAccountId);
      dd.onChange((val) => {
        newAccountId = val;
        const acc = this.plugin.settings.accounts.find(a => a.id === val);
        ruleIconSpan.innerHTML = acc ? PROVIDER_SVG[acc.type] || '' : '';
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
      await this.plugin.saveSettings();
      this.display();
    });

    // ── Vendor icon ──
    if (account) {
      const vendorSpan = row.createSpan({ cls: "mobile-option-setting-item-option-icon" });
      vendorSpan.innerHTML = PROVIDER_SVG[account.type] || '';
    }

    // ── Inline dropdowns ──
    const nameSpan = row.createSpan({ cls: "mobile-option-setting-item-name" });

    // Rule selector
    const ruleSelect = nameSpan.createEl("select", { cls: "dropdown" });
    ruleSelect.style.cssText = "border:none;background:transparent;font-size:inherit;color:inherit;padding:0;margin-right:4px;cursor:pointer;";
    for (const r of this.plugin.settings.rules) {
      const a = this.plugin.settings.accounts.find((acc) => acc.id === r.accountId);
      const opt = ruleSelect.createEl("option", {
        text: `${a?.name || "?"}: ${r.cloudFolder || "(root)"} ↔ ${r.localFolder || "(vault)"}`,
        value: r.id,
      });
      if (r.id === step.ruleId) opt.selected = true;
    }
    ruleSelect.addEventListener("change", async () => {
      step.ruleId = ruleSelect.value;
      await this.plugin.saveSettings();
      this.display();
    });

    nameSpan.createEl("span", { text: " → " });

    // Operation selector
    const opSelect = nameSpan.createEl("select", { cls: "dropdown" });
    opSelect.style.cssText = "border:none;background:transparent;font-size:inherit;color:inherit;padding:0;cursor:pointer;";
    for (const op of ALL_OPS) {
      const opt = opSelect.createEl("option", { text: op.label, value: op.value });
      if (op.value === step.operation) opt.selected = true;
    }
    opSelect.addEventListener("change", async () => {
      step.operation = opSelect.value as SyncOpType;
      await this.plugin.saveSettings();
      this.display();
    });

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
  }

  private renderAddPipelineRow(pipelineContainer: HTMLElement) {
    let newRuleId = this.plugin.settings.rules[0]?.id || "";
    let newOp: SyncOpType = "cloud-update";

    const s = new Setting(pipelineContainer).setName("Add step");

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
