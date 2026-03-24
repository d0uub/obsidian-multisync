/**
 * Integration tests for the full sync pipeline with real cloud providers.
 *
 * Reads credentials/rules from data.json in an Obsidian vault.
 * Uses a temp directory as the local vault (MockApp).
 * Tests each of the 6 sync operations individually.
 *
 * Usage:
 *   INTEGRATION_TEST=1 VAULT_PATH=D:\obsidian npx vitest run tests/integration/sync-pipeline.test.ts
 *
 * VAULT_PATH  — path to the Obsidian vault (default: D:\obsidian)
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { MultiSyncSettings, SyncStep, SyncOpType, CloudAccount } from "../../src/types";
import type { ICloudProvider } from "../../src/providers/ICloudProvider";
import { DropboxProvider } from "../../src/providers/DropboxProvider";
import { OneDriveProvider } from "../../src/providers/OneDriveProvider";
import { GDriveProvider } from "../../src/providers/GDriveProvider";
import { runPipeline } from "../../src/sync/pipeline";
import type { PipelineContext } from "../../src/sync/pipeline";
import { createMockApp } from "../mocks/mockApp";

const INTEGRATION = !!process.env.INTEGRATION_TEST;
const VAULT_PATH = process.env.VAULT_PATH || "D:\\obsidian";
const SETTLE_MS = 3000;

// ── Helpers ──

function loadSettings(): MultiSyncSettings {
  const dataPath = path.resolve(VAULT_PATH, ".obsidian/plugins/multisync/data.json");
  return JSON.parse(fs.readFileSync(dataPath, "utf-8"));
}

function createProvider(account: CloudAccount): ICloudProvider {
  const creds = account.credentials;
  switch (account.type) {
    case "dropbox":
      return new DropboxProvider(
        creds.accessToken, creds.refreshToken,
        creds.appKey || "y8k73tvwvsg3kbi",
        parseInt(creds.tokenExpiry || "0", 10),
      );
    case "onedrive":
      return new OneDriveProvider(
        creds.accessToken, creds.refreshToken,
        creds.clientId || "03beb548-4548-4835-ba4e-18ac1f469442",
        parseInt(creds.tokenExpiry || "0", 10),
      );
    case "gdrive":
      return new GDriveProvider(
        creds.accessToken, creds.refreshToken,
        creds.clientId || "",
        creds.clientSecret || "",
        parseInt(creds.tokenExpiry || "0", 10),
      );
    default:
      throw new Error(`Unsupported provider: ${account.type}`);
  }
}

function buildSteps(settings: MultiSyncSettings): SyncStep[] {
  const ops: SyncOpType[] = [
    "cloud-update", "local-update", "cloud-add", "local-add",
    "local-delete", "cloud-delete",
  ];
  const steps: SyncStep[] = [];
  for (const rule of settings.rules) {
    for (const op of ops) {
      steps.push({ ruleId: rule.id, operation: op });
    }
  }
  return steps;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function textToBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function bufferToText(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

// ── Test suite ──

describe.skipIf(!INTEGRATION)("Sync Pipeline (integration)", () => {
  let settings: MultiSyncSettings;
  let providers: Map<string, ICloudProvider>;
  let tempDir: string;
  let mockApp: ReturnType<typeof createMockApp>;
  const cleanupCloud: { provider: ICloudProvider; cloudFolder: string; file: string }[] = [];

  function makeCtx(): PipelineContext {
    return {
      app: mockApp as any,
      settings,
      providers,
      saveSettings: async () => { /* delta tokens stay in memory */ },
      onProgress: (msg) => console.log(`  [progress] ${msg}`),
    };
  }

  async function fullSync() {
    const steps = buildSteps(settings);
    return runPipeline(steps, makeCtx());
  }

  beforeAll(async () => {
    settings = loadSettings();
    expect(settings.rules.length).toBeGreaterThan(0);
    expect(settings.accounts.length).toBeGreaterThan(0);

    // Create providers
    providers = new Map();
    for (const account of settings.accounts) {
      providers.set(account.id, createProvider(account));
    }

    // Create temp vault directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multisync-test-"));
    mockApp = createMockApp(tempDir);

    // Pre-seed local files from cloud so the pipeline doesn't try to download everything.
    // We list cloud files, create matching empty local files, save registry, and get delta token.
    const processedAccounts = new Set<string>();
    for (const rule of settings.rules) {
      const account = settings.accounts.find(a => a.id === rule.accountId);
      if (!account) continue;
      const provider = providers.get(account.id);
      if (!provider) continue;

      // Create local folder
      const localBase = rule.localFolder
        ? path.join(tempDir, rule.localFolder)
        : tempDir;
      fs.mkdirSync(localBase, { recursive: true });

      // List cloud files and create matching empty locals
      console.log(`Pre-seeding local from cloud (${account.name}: ${rule.cloudFolder})...`);
      const cloudFiles = await provider.listFiles(rule.cloudFolder);
      for (const cf of cloudFiles) {
        const localPath = path.join(localBase, cf.path);
        if (cf.isFolder) {
          fs.mkdirSync(localPath, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          // Write empty file with matching mtime (so no update is detected)
          fs.writeFileSync(localPath, "");
          const sec = cf.mtime / 1000;
          try { fs.utimesSync(localPath, sec, sec); } catch {}
        }
      }
      console.log(`  Created ${cloudFiles.length} local stubs`);

      // Save cloud registry so pipeline knows this is the baseline
      if (!processedAccounts.has(account.id)) {
        processedAccounts.add(account.id);
        const pfx = rule.cloudFolder.startsWith("/")
          ? rule.cloudFolder.substring(1)
          : rule.cloudFolder;
        const registryEntries = cloudFiles.map(f => ({
          id: f.cloudId || (pfx ? `${pfx}/${f.path}` : f.path),
          path: pfx ? `${pfx}/${f.path}` : f.path,
          mtime: f.mtime,
          size: f.size,
          isFolder: f.isFolder,
          hash: f.hash,
          ctime: f.ctime,
        }));
        const { saveCloudRegistry } = await import("../../src/utils/cloudRegistry");
        await saveCloudRegistry(account.id, registryEntries);

        // Get baseline delta token
        const baselineToken = await provider.getBaselineDeltaToken();
        if (!account.deltaTokens) account.deltaTokens = {};
        account.deltaTokens["me"] = baselineToken;
        console.log(`  Delta baseline token acquired`);
      }
    }

    // Run a quick sync to verify baseline — should be 0 actions
    console.log("Baseline sync (verifying no spurious actions)...");
    const result = await fullSync();
    console.log(`  Baseline: ${result.actionsExecuted} actions, ${result.errors.length} errors`);
    if (result.errors.length) console.log("  Errors:", result.errors);
    await sleep(SETTLE_MS);
  }, 120_000);

  afterAll(async () => {
    // Cleanup cloud test files
    for (const c of cleanupCloud) {
      try { await c.provider.deleteFile(c.cloudFolder, c.file); } catch {}
    }
    // Cleanup temp dir
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);



  // ── Test: for each rule ──

  for (const ruleRef of (INTEGRATION ? loadSettings() : { rules: [] as any[] }).rules) {
    const ruleId = ruleRef.id;

    describe(`Rule: ${ruleId}`, () => {
      let rule: typeof ruleRef;
      let account: CloudAccount;
      let provider: ICloudProvider;

      beforeAll(() => {
        settings = loadSettings();
        rule = settings.rules.find((r: any) => r.id === ruleId)!;
        account = settings.accounts.find((a: any) => a.id === rule.accountId)!;
        provider = providers.get(account.id)!;
        console.log(`\nTesting ${account.type} (${account.name}) — cloud: ${rule.cloudFolder} ↔ local: ${rule.localFolder}`);
      });

      // ── 1. local-add ──
      it("local-add: create local file → sync → file on cloud", async () => {
        const ts = Date.now();
        const fname = `test-local-add-${ts}.md`;
        const content = `local-add-${ts}`;

        // Create file in temp vault
        const localDir = rule.localFolder
          ? path.join(tempDir, rule.localFolder)
          : tempDir;
        fs.mkdirSync(localDir, { recursive: true });
        fs.writeFileSync(path.join(localDir, fname), content, "utf-8");

        cleanupCloud.push({ provider, cloudFolder: rule.cloudFolder, file: fname });

        // Sync
        const result = await fullSync();
        expect(result.errors).toHaveLength(0);
        await sleep(SETTLE_MS);

        // Verify cloud
        const entry = await provider.stat(rule.cloudFolder, fname);
        expect(entry).not.toBeNull();
        const cloudBuf = await provider.readFile(rule.cloudFolder, fname);
        expect(bufferToText(cloudBuf)).toBe(content);
      }, 60_000);

      // ── 2. cloud-add ──
      it("cloud-add: create cloud file → sync → file locally", async () => {
        const ts = Date.now();
        const fname = `test-cloud-add-${ts}.md`;
        const content = `cloud-add-${ts}`;

        // Create on cloud
        await provider.writeFile(rule.cloudFolder, fname, textToBuffer(content), ts);
        cleanupCloud.push({ provider, cloudFolder: rule.cloudFolder, file: fname });

        await sleep(SETTLE_MS);

        // Sync
        const result = await fullSync();
        expect(result.errors).toHaveLength(0);
        await sleep(SETTLE_MS);

        // Verify local
        const localPath = rule.localFolder
          ? path.join(tempDir, rule.localFolder, fname)
          : path.join(tempDir, fname);
        expect(fs.existsSync(localPath)).toBe(true);
        expect(fs.readFileSync(localPath, "utf-8")).toBe(content);
      }, 60_000);

      // ── 3. local-update ──
      it("local-update: modify local file → sync → cloud updated", async () => {
        const ts = Date.now();
        const fname = `test-local-upd-${ts}.md`;

        // Create initial on cloud + sync to local
        await provider.writeFile(rule.cloudFolder, fname, textToBuffer("original"), ts - 120_000);
        cleanupCloud.push({ provider, cloudFolder: rule.cloudFolder, file: fname });

        await sleep(SETTLE_MS);
        await fullSync();
        await sleep(SETTLE_MS);

        // Modify locally with newer content
        const localPath = rule.localFolder
          ? path.join(tempDir, rule.localFolder, fname)
          : path.join(tempDir, fname);
        expect(fs.existsSync(localPath)).toBe(true);
        fs.writeFileSync(localPath, "modified-local", "utf-8");

        // Sync
        const result = await fullSync();
        expect(result.errors).toHaveLength(0);
        await sleep(SETTLE_MS);

        // Verify cloud has updated content
        const cloudBuf = await provider.readFile(rule.cloudFolder, fname);
        expect(bufferToText(cloudBuf)).toBe("modified-local");
      }, 90_000);

      // ── 4. cloud-update ──
      it("cloud-update: modify cloud file → sync → local updated", async () => {
        const ts = Date.now();
        const fname = `test-cloud-upd-${ts}.md`;

        // Create initial on cloud + sync to local
        await provider.writeFile(rule.cloudFolder, fname, textToBuffer("original-cloud"), ts - 120_000);
        cleanupCloud.push({ provider, cloudFolder: rule.cloudFolder, file: fname });

        await sleep(SETTLE_MS);
        await fullSync();
        await sleep(SETTLE_MS);

        // Overwrite on cloud with newer mtime
        await provider.writeFile(rule.cloudFolder, fname, textToBuffer("modified-cloud"), Date.now());
        await sleep(SETTLE_MS);

        // Sync
        const result = await fullSync();
        expect(result.errors).toHaveLength(0);
        await sleep(SETTLE_MS);

        // Verify local has updated content
        const localPath = rule.localFolder
          ? path.join(tempDir, rule.localFolder, fname)
          : path.join(tempDir, fname);
        expect(fs.existsSync(localPath)).toBe(true);
        expect(fs.readFileSync(localPath, "utf-8")).toBe("modified-cloud");
      }, 90_000);

      // ── 5. local-delete ──
      it("local-delete: delete local file → sync → cloud deleted", async () => {
        const ts = Date.now();
        const fname = `test-local-del-${ts}.md`;

        // Create file locally + sync to cloud
        const localDir = rule.localFolder
          ? path.join(tempDir, rule.localFolder)
          : tempDir;
        fs.mkdirSync(localDir, { recursive: true });
        fs.writeFileSync(path.join(localDir, fname), "delete-me", "utf-8");

        await fullSync();
        await sleep(SETTLE_MS);

        // Verify it reached cloud
        const before = await provider.stat(rule.cloudFolder, fname);
        expect(before).not.toBeNull();

        // Establish delta baseline (sync again so registry includes this file)
        await fullSync();
        await sleep(SETTLE_MS);

        // Delete locally
        const localPath = path.join(localDir, fname);
        fs.unlinkSync(localPath);

        // Sync — should detect local-delete and remove from cloud
        const result = await fullSync();
        expect(result.errors).toHaveLength(0);
        await sleep(SETTLE_MS);

        // Verify cloud file is gone
        const after = await provider.stat(rule.cloudFolder, fname);
        expect(after).toBeNull();
      }, 120_000);

      // ── 6. cloud-delete ──
      it("cloud-delete: delete cloud file → sync → local deleted", async () => {
        const ts = Date.now();
        const fname = `test-cloud-del-${ts}.md`;

        // Create on cloud + sync to local
        await provider.writeFile(rule.cloudFolder, fname, textToBuffer("will-be-deleted"), ts);
        await sleep(SETTLE_MS);

        await fullSync();
        await sleep(SETTLE_MS);

        // Verify local exists
        const localPath = rule.localFolder
          ? path.join(tempDir, rule.localFolder, fname)
          : path.join(tempDir, fname);
        expect(fs.existsSync(localPath)).toBe(true);

        // Establish delta baseline
        await fullSync();
        await sleep(SETTLE_MS);

        // Delete on cloud
        await provider.deleteFile(rule.cloudFolder, fname);

        // Wait for delta propagation (Dropbox needs more time)
        const delWait = account.type === "dropbox" ? 15_000 : 5_000;
        console.log(`  Waiting ${delWait / 1000}s for delta propagation...`);
        await sleep(delWait);

        // Sync — should detect cloud-delete and remove local
        const result = await fullSync();
        expect(result.errors).toHaveLength(0);
        await sleep(SETTLE_MS);

        // Verify local file is gone
        expect(fs.existsSync(localPath)).toBe(false);
      }, 120_000);
    });
  }
});
