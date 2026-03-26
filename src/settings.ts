
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
import { PROVIDERS, PROVIDER_LIST, needsManualPaste } from "./providers/registry";
import { FolderSuggest } from "./ui/FolderSuggest";
import { deleteCloudRegistry } from "./utils/cloudRegistry";
import { setSvgContent } from "./utils/helpers";

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
  private quotaCache = new Map<string, { used: number; total: number } | null>();


  constructor(app: App, plugin: MultiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Ensure account exists for a rule, or remove it if unused.
   * @param accountId The account id to check
   * @param ensurePresent If true, ensure account exists; if false, remove if unused
   * @param type Optional type for creation
   */

  async ensureAccountSync(accountId: string, ensurePresent: boolean, type?: CloudProviderType) {
    if (!ensurePresent) {
      // Wipe delta token + registry for the account — next sync will re-fetch
      const acct = this.plugin.settings.accounts.find(a => a.id === accountId);
      if (acct) acct.deltaTokens = undefined;
      deleteCloudRegistry(accountId).catch(() => {});
      await this.plugin.saveSettings();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  SVG helper factories                                               */
  /* ------------------------------------------------------------------ */

  private createRemoveIcon(parent: HTMLElement, onClick: () => Promise<void>): HTMLSpanElement {
    const span = parent.createSpan({ cls: "mobile-option-setting-item-remove-icon" });
    setIcon(span, "minus-circle");
    span.addEventListener("click", (e) => { e.stopPropagation(); void onClick(); });
    return span;
  }

  private createDragIcon(parent: HTMLElement): HTMLSpanElement {
    const span = parent.createSpan({ cls: "mobile-option-setting-item-drag-icon" });
    span.setAttribute("draggable", "true");
    setIcon(span, "grip-vertical");
    return span;
  }

  /* ------------------------------------------------------------------ */
  /*  display()                                                          */
  /* ------------------------------------------------------------------ */

  hide(): void {
    this.quotaCache.clear();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ─── Cloud Accounts ───
    const accountGroup = containerEl.createDiv({ cls: "setting-group" });
    new Setting(accountGroup).setName("Cloud accounts").setHeading();
    const accountItems = accountGroup.createDiv({ cls: "setting-items" });
    for (const account of this.plugin.settings.accounts) {
      this.renderAccount(accountItems, account);
    }
    this.renderAddAccountRow(accountItems);

    // ─── Sync Rules ───
    const rulesGroup = containerEl.createDiv({ cls: "setting-group" });
    new Setting(rulesGroup).setName("Cloud drive mapping")
      .setDesc("Drag to re-order drive mapping sequence. Advanced mode able to fully customize drive and action order.")
      .setHeading();
    const rulesListEl = rulesGroup.createDiv({ cls: "setting-items" });
    for (let ri = 0; ri < this.plugin.settings.rules.length; ri++) {
      this.renderRule(rulesListEl, this.plugin.settings.rules[ri], ri);
    }
    this.renderAddRuleRow(rulesListEl);

    // ─── Sync Mode ───
    const syncGroup = containerEl.createDiv({ cls: "setting-group" });
    new Setting(syncGroup).setName("Sync").setHeading();

    const syncItems = syncGroup.createDiv({ cls: "setting-items multisync-pipeline-list" });

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

    // Backup before cloud delete — hidden (default off, cloud has its own trash)
    // this.plugin.settings.backupBeforeCloudDelete is respected if already set

    const isMobile = Platform.isMobile;
    const maxLimit = isMobile ? 20 : 200;
    const curMax = Math.min(this.plugin.settings.maxFileSizeMB || maxLimit, maxLimit);
    new Setting(syncItems)
      .setName("Max file size")
      .setDesc(`${curMax} MB — files larger will be skipped during sync`)
      .addSlider((slider) =>
        slider.setLimits(1, maxLimit, 1)
          .setValue(curMax)
          .onChange(async (val) => {
            this.plugin.settings.maxFileSizeMB = val;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    // Advanced Mode — hidden (pro feature)

    if (this.plugin.settings.advancedMode) {
      for (let i = 0; i < this.plugin.settings.pipeline.length; i++) {
        this.renderPipelineStep(syncItems, i);
      }
      this.renderAddPipelineRow(syncItems);
    }

    // ─── Manual Sync ───
    new Setting(containerEl).setName("Actions").setHeading();
    new Setting(containerEl)
      .setName("Run sync now")
      .setDesc("Execute the pipeline defined above.")
      .addButton((btn) =>
        btn
          .setButtonText("Sync")
          .setCta()
          .onClick(async () => {
            await this.plugin.runSync();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Clear cache")
          .onClick(async () => {
            for (const a of this.plugin.settings.accounts) {
              await deleteCloudRegistry(a.id);
            }
            await this.plugin.saveSettings();
            new Notice("Cache cleared — next sync will do a full scan.");
          })
      );

  }

  /* ------------------------------------------------------------------ */
  /*  Accounts                                                           */
  /* ------------------------------------------------------------------ */

  private renderAccount(containerEl: HTMLElement, account: CloudAccount) {
    const isAuthed = !!(account.credentials.accessToken && account.credentials.refreshToken);

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
      // Clean up IndexedDB registry for the removed account
      deleteCloudRegistry(account.id).catch(() => {});
      await this.plugin.saveSettings();
      this.plugin.initProviders();
      this.display();
    });

    // ── Vendor icon ──
    const vendorIcon = row.createSpan({ cls: "mobile-option-setting-item-option-icon" });
    setSvgContent(vendorIcon, PROVIDERS[account.type]?.svgIcon || '');

    // ── Inline-editable name ──
    const nameSpan = row.createSpan({ cls: "mobile-option-setting-item-name multisync-account-name" });
    nameSpan.textContent = account.name;
    nameSpan.title = "Click to rename";

    let accountEditing = false;

    nameSpan.addEventListener("click", () => {
      if (accountEditing) return;
      accountEditing = true;
      nameSpan.addClass("is-hidden");

      const inputWrapper = row.insertBefore(document.createElement("span"), nameSpan.nextSibling);
      inputWrapper.className = "mobile-option-setting-item-name";
      const textInput = document.createElement("input");
      textInput.type = "text";
      textInput.placeholder = "Account name";
      textInput.value = account.name;
      textInput.addClass("multisync-account-input");
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
        nameSpan.removeClass("is-hidden");
      };

      textInput.addEventListener("blur", () => { void finish(); });
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
        } catch (e) {
          new Notice(`${account.name}: ✗ ${e instanceof Error ? e.message : String(e)}`);
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

      // Reset sync state (delta token + registry)
      this.createClickableIcon(row, "rotate-ccw", "Reset sync state", async () => {
        if (account.deltaTokens) {
          delete account.deltaTokens["me"];
        }
        deleteCloudRegistry(account.id).catch(() => {});
        await this.plugin.saveSettings();
        new Notice(`${account.name}: Sync state reset — next sync will re-scan`);
      });

      // ── Quota fuel bar ──
      const provider = this.plugin.providers.get(account.id);
      if (provider) {
        const barWrap = document.createElement("div");
        barWrap.className = "multisync-quota-bar";

        row.insertAdjacentElement("afterend", barWrap);

        const renderBar = (q: { used: number; total: number } | null) => {
          if (!q) { barWrap.remove(); return; }
          const pct = Math.min(100, Math.round((q.used / q.total) * 100));
          const usedGB = (q.used / 1e9).toFixed(1);
          const totalGB = (q.total / 1e9).toFixed(1);
          const color = pct > 90 ? "var(--text-error)" : pct > 70 ? "var(--text-warning)" : "var(--interactive-accent)";
          barWrap.empty();
          const inner = barWrap.createDiv({ cls: "multisync-quota-bar-inner" });
          const track = inner.createDiv({ cls: "multisync-quota-track" });
          const fill = track.createDiv({ cls: "multisync-quota-fill" });
          fill.style.setProperty("--ms-quota-pct", `${pct}%`);
          fill.style.setProperty("--ms-quota-color", color);
          inner.createSpan({ text: `${usedGB} / ${totalGB} GB (${pct}%)` });
        };

        // Use cached quota if available; only fetch once per settings open
        if (this.quotaCache.has(account.id)) {
          renderBar(this.quotaCache.get(account.id)!);
        } else {
          provider.getQuota().then((q) => {
            this.quotaCache.set(account.id, q);
            renderBar(q);
          }).catch((e) => { console.error("getQuota error:", e); barWrap.remove(); });
        }
      }
    } else {
      this.createClickableIcon(row, "log-in", "Authorize", async () => {
        await this.startOAuthFlow(account);
      });
    }
  }

  private createClickableIcon(parent: HTMLElement, iconId: string, tooltip: string, onClick: () => void | Promise<void>): HTMLSpanElement {
    const span = parent.createSpan({ cls: "clickable-icon", attr: { "aria-label": tooltip } });
    setIcon(span, iconId);
    span.addEventListener("click", (e) => { e.stopPropagation(); void onClick(); });
    return span;
  }

  private renderAddAccountRow(containerEl: HTMLElement) {
    const MAX_ACCOUNTS = 3;
    if (this.plugin.settings.accounts.length >= MAX_ACCOUNTS) {
      const note = new Setting(containerEl)
        .setName("Account limit reached")
        .setDesc(`Free version supports up to ${MAX_ACCOUNTS} cloud accounts.`);
      note.settingEl.addClass("multisync-limit-note");
      return;
    }

    let newType: CloudProviderType = "dropbox";

    const s = new Setting(containerEl).setName("");
    s.controlEl.addClass("multisync-add-row-controls");

    // Icon-based provider selector
    const selectorRow = s.controlEl.createDiv({ cls: "multisync-provider-selector" });
    const iconButtons: HTMLElement[] = [];
    for (const meta of PROVIDER_LIST) {
      const btn = selectorRow.createDiv({ cls: "multisync-provider-icon-btn", attr: { "aria-label": meta.label } });
      setSvgContent(btn, meta.svgIcon);
      // Scale icon
      const svg = btn.querySelector("svg");
      if (svg) { svg.setAttribute("width", "20"); svg.setAttribute("height", "20"); }
      if (meta.type === newType) btn.addClass("is-selected");
      btn.title = meta.label;
      btn.addEventListener("click", () => {
        newType = meta.type;
        for (const b of iconButtons) b.removeClass("is-selected");
        btn.addClass("is-selected");
      });
      iconButtons.push(btn);
    }

    s.addButton((btn) =>
      btn.setButtonText("+").setCta().onClick(async () => {
        // Use provider label as temporary name; will be replaced after OAuth with display name
        const baseName = PROVIDERS[newType]?.label || newType;
        const existingNames = new Set(this.plugin.settings.accounts.map(a => a.name));
        let finalName = baseName;
        if (existingNames.has(finalName)) {
          let i = 1;
          while (existingNames.has(`${baseName} (${i})`)) i++;
          finalName = `${baseName} (${i})`;
        }

        const newAccount: CloudAccount = {
          id: "account-" + Date.now(),
          type: newType,
          name: finalName,
          credentials: {},
        };
        // Auto-fill default credentials (e.g., hardcoded client IDs)
        const meta = PROVIDERS[newType];
        if (meta) meta.autoFillCreds(newAccount.credentials);
        this.plugin.settings.accounts.push(newAccount);
        await this.plugin.saveSettings();
        this.plugin.initProviders();

        // Auto-start OAuth if no credentials are needed upfront
        if (meta && meta.getMissingCreds(newAccount.credentials).length === 0) {
          this.display();
          await this.startOAuthFlow(newAccount);
        } else {
          this.display();
        }
      })
    );
  }

  private renderCredentials(containerEl: HTMLElement, account: CloudAccount) {
    const meta = PROVIDERS[account.type];
    if (!meta) return;
    const fields = meta.credentialFields;

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
      // Remove the rule
      this.plugin.settings.rules =
        this.plugin.settings.rules.filter((r) => r.id !== rule.id);
      this.plugin.settings.pipeline =
        this.plugin.settings.pipeline.filter((s) => s.ruleId !== rule.id);
      await this.ensureAccountSync(rule.accountId, false);
      await this.plugin.saveSettings();
      this.display();
    });

    // Vendor icon at far left of row
    if (account) {
      const vendorIcon = row.createSpan({ cls: "mobile-option-setting-item-option-icon" });
      setSvgContent(vendorIcon, PROVIDERS[account.type]?.svgIcon || '');
      // Move icon to be the first child after remove icon
      if (row.childNodes.length > 1 && row.childNodes[1] !== vendorIcon) {
        row.insertBefore(vendorIcon, row.childNodes[1]);
      }
    }
    // Name area: show mapping with folder icon, no dropdown or inline edit
    const nameSpan = row.createSpan({ cls: "mobile-option-setting-item-name" });
    const accountName = account ? account.name : rule.accountId;
    nameSpan.createEl("span", { text: `${accountName}: ${rule.cloudFolder || "(drive root)"} ↔ ` });
    // Folder icon before local folder
    const folderIcon = nameSpan.createSpan();
    setIcon(folderIcon, "folder");
    folderIcon.addClass("multisync-folder-icon");
    nameSpan.createEl("span", { text: rule.localFolder || "(entire vault)" });

    // ── Drag handle (hidden in advanced mode — pipeline controls ordering) ──
    if (!this.plugin.settings.advancedMode) {
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
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const from = this.dragSourceIndex;
      const to = index;
      if (from !== to && from >= 0) {
        void (async () => {
          const arr = this.plugin.settings.rules;
          const [moved] = arr.splice(from, 1);
          arr.splice(to, 0, moved);
          await this.plugin.saveSettings();
          this.display();
        })();
      }
    });
    } // end if (!advancedMode) — drag handle
  }

  private renderAddRuleRow(containerEl: HTMLElement) {
    const MAX_RULES = 3;
    if (this.plugin.settings.rules.length >= MAX_RULES) {
      const note = new Setting(containerEl)
        .setName("Rule limit reached")
        .setDesc(`Free version supports up to ${MAX_RULES} sync rules.`);
      note.settingEl.addClass("multisync-limit-note");
      return;
    }

    let newAccountId = this.plugin.settings.accounts[0]?.id || "";
    let newCloudFolder = "";
    let newLocalFolder = "";

    const s = new Setting(containerEl).setName("");
    s.controlEl.addClass("multisync-add-row-controls");

    // Left group for inputs
    const leftGroup = s.controlEl.createDiv({ cls: "multisync-add-rule-left" });

    const firstAccount = this.plugin.settings.accounts[0];
    const ruleIconSpan = document.createElement("span");
    ruleIconSpan.className = "multisync-inline-icon";
    if (firstAccount) setSvgContent(ruleIconSpan, PROVIDERS[firstAccount.type]?.svgIcon || '');

    s.addDropdown((dd) => {
      dd.selectEl.parentElement?.insertBefore(ruleIconSpan, dd.selectEl);
      for (const a of this.plugin.settings.accounts) {
        dd.addOption(a.id, a.name);
      }
      if (newAccountId) dd.setValue(newAccountId);
      dd.onChange((val) => {
        newAccountId = val;
        const acc = this.plugin.settings.accounts.find(a => a.id === val);
        setSvgContent(ruleIconSpan, acc ? PROVIDERS[acc.type]?.svgIcon || '' : '');
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

    // Move inputs into leftGroup (they were appended to controlEl by Setting API)
    const controls = Array.from(s.controlEl.children).filter(c => c !== leftGroup);
    // Move all except the last child (which will be the "+" button added next)
    for (const c of controls) leftGroup.appendChild(c);

    s.addButton((btn) =>
      btn.setButtonText("+").setCta().onClick(async () => {
        // Ensure account exists for this mapping
        let type: CloudProviderType = "dropbox";
        const accFromDropdown = this.plugin.settings.accounts[0];
        if (accFromDropdown && accFromDropdown.id === newAccountId) {
          type = accFromDropdown.type;
        }
        // Reset delta for this account so next sync re-fetches with new folder included
        const acctForMapping = this.plugin.settings.accounts.find(a => a.id === newAccountId);
        if (acctForMapping) acctForMapping.deltaTokens = undefined;
        deleteCloudRegistry(newAccountId).catch(() => {});
        await this.ensureAccountSync(newAccountId, true, type);
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
      setSvgContent(vendorSpan, PROVIDERS[account.type]?.svgIcon || '');
    }

    // ── Inline dropdowns ──
    const nameSpan = row.createSpan({ cls: "mobile-option-setting-item-name" });

    // Rule selector
    const ruleSelect = nameSpan.createEl("select", { cls: "dropdown" });
    ruleSelect.addClass("multisync-pipeline-rule-select");
    for (const r of this.plugin.settings.rules) {
      const a = this.plugin.settings.accounts.find((acc) => acc.id === r.accountId);
      const opt = ruleSelect.createEl("option", {
        text: `${a?.name || "?"}: ${r.cloudFolder || "(root)"} ↔ ${r.localFolder || "(vault)"}`,
        value: r.id,
      });
      if (r.id === step.ruleId) opt.selected = true;
    }
    ruleSelect.addEventListener("change", () => {
      step.ruleId = ruleSelect.value;
      void this.plugin.saveSettings().then(() => this.display());
    });

    nameSpan.createEl("span", { text: " → " });

    // Operation selector
    const opSelect = nameSpan.createEl("select", { cls: "dropdown" });
    opSelect.addClass("multisync-pipeline-select");
    for (const op of ALL_OPS) {
      const opt = opSelect.createEl("option", { text: op.label, value: op.value });
      if (op.value === step.operation) opt.selected = true;
    }
    opSelect.addEventListener("change", () => {
      step.operation = opSelect.value as SyncOpType;
      void this.plugin.saveSettings().then(() => this.display());
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
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const from = this.dragSourceIndex;
      const to = index;
      if (from !== to && from >= 0) {
        void (async () => {
          const arr = this.plugin.settings.pipeline;
          const [moved] = arr.splice(from, 1);
          arr.splice(to, 0, moved);
          this.expandedSteps.clear();
          await this.plugin.saveSettings();
          this.display();
        })();
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
    // Show native type warning for GDrive before OAuth
    if (account.type === "gdrive") {
      const ok = await this.showGDriveWarning();
      if (!ok) return;
    }

    const missing = this.getMissingCredFields(account);
    if (missing.length > 0) {
      new Notice(`Set ${missing.join(", ")} in credentials first.`);
      return;
    }

    const manual = needsManualPaste();
    const meta = PROVIDERS[account.type];
    if (!meta) {
      new Notice("Unknown provider type");
      return;
    }

    let authUrl: string;
    let verifier: string;
    let codePromise: Promise<string> | undefined;

    try {
      const r = await meta.getAuthUrl(account.credentials, manual);
      authUrl = r.authUrl;
      verifier = r.verifier;
      codePromise = r.codePromise;
    } catch (e) {
      new Notice(`OAuth error: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    this.plugin.oauth2Info = { verifier, accountId: account.id, manual };

    if (codePromise) {
      // Loopback flow (GDrive): open browser and auto-capture code via localhost server
      window.open(authUrl);
      new Notice("Browser opened for authorization. Waiting for redirect...");
      const code = await codePromise;
      if (!code) {
        new Notice("Authorization failed or was cancelled.");
        this.plugin.oauth2Info = {};
        return;
      }
      try {
        const result = await meta.exchangeCode(account.credentials, code, verifier, false);
        account.credentials.accessToken = result.accessToken;
        account.credentials.refreshToken = result.refreshToken;
        account.credentials.tokenExpiry = String(Date.now() + result.expiresIn * 1000 - 60000);
        await this.plugin.saveSettings();
        this.plugin.initProviders();
        // Auto-name account from cloud identity
        const provider = this.plugin.providers.get(account.id);
        if (provider) {
          try {
            const name = await provider.getDisplayName();
            if (name && name !== account.name) {
              account.name = name;
              await this.plugin.saveSettings();
            }
          } catch { /* keep existing name */ }
        }
        new Notice(`${account.name} connected!`);
        this.display();
      } catch (e) {
        new Notice(`Auth failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.plugin.oauth2Info = {};
    } else if (manual) {
      new AuthCodeModal(this.app, this.plugin, account, verifier, authUrl).open();
    } else {
      window.open(authUrl);
      new Notice("Browser opened for authorization. Return here after granting access.");
    }
  }

  private getMissingCredFields(account: CloudAccount): string[] {
    const meta = PROVIDERS[account.type];
    return meta ? meta.getMissingCreds(account.credentials) : [];
  }

  private showGDriveWarning(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const modal = new Modal(this.app);
      let resolved = false;
      modal.titleEl.setText("Google Drive sync (experimental)");
      modal.contentEl.createEl("p", {
        text: "Google Drive sync is experimental. Please note the following limitations:",
      });
      const list = modal.contentEl.createEl("ul");
      list.createEl("li", {
        text: "Google native files (docs, sheets, slides, etc.) are not supported and will be skipped.",
      });
      list.createEl("li", {
        text: "Duplicate file or folder names in the same directory are not supported and may cause sync issues.",
      });
      const btnRow = modal.contentEl.createEl("div");
      btnRow.addClass("multisync-modal-btn-row");
      const okBtn = btnRow.createEl("button", { text: "OK", cls: "mod-cta" });
      okBtn.onclick = () => { resolved = true; modal.close(); };
      modal.onClose = () => { resolve(resolved); };
      modal.open();
    });
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
      .setName("Authorization code")
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
          } catch (e) {
            new Notice(`Auth failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        })
      );
  }

  private async exchangeCode(code: string) {
    const creds = this.account.credentials;
    const meta = PROVIDERS[this.account.type];
    if (!meta) throw new Error("Unknown provider type");
    const r = await meta.exchangeCode(creds, code, this.verifier, true);
    creds.accessToken = r.accessToken;
    creds.refreshToken = r.refreshToken;
    creds.tokenExpiry = String(Date.now() + r.expiresIn * 1000 - 60000);
    await this.plugin.saveSettings();
    this.plugin.initProviders();
    // Auto-name account from cloud identity
    const provider = this.plugin.providers.get(this.account.id);
    if (provider) {
      try {
        const name = await provider.getDisplayName();
        if (name && name !== this.account.name) {
          this.account.name = name;
          await this.plugin.saveSettings();
        }
      } catch { /* keep existing name */ }
    }
    this.plugin.settingsTab?.display();
  }

  onClose() {
    this.contentEl.empty();
    this.plugin.oauth2Info = {};
  }
}
