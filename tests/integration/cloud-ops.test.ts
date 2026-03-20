/**
 * Integration tests for cloud sync operations.
 * Reads data.json from the Obsidian vault to get live credentials.
 * Tests each rule/provider: cloud-add, cloud-delete, local-add, local-delete, local-update, cloud-update.
 *
 * Run with: INTEGRATION_TEST=1 npx vitest run tests/integration/cloud-ops.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { MultiSyncSettings, CloudAccount, SyncRule } from "../../src/types";
import type { ICloudProvider } from "../../src/providers/ICloudProvider";
import { DropboxProvider } from "../../src/providers/DropboxProvider";
import { OneDriveProvider } from "../../src/providers/OneDriveProvider";

// Skip entire suite if not integration mode
const INTEGRATION = !!process.env.INTEGRATION_TEST;

// ── Helpers ──

function loadSettings(): MultiSyncSettings {
  const vaultPath = process.env.VAULT_PATH || "D:\\obsidian";
  const dataPath = resolve(vaultPath, ".obsidian/plugins/obsidian-multisync/data.json");
  return JSON.parse(readFileSync(dataPath, "utf-8"));
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
    default:
      throw new Error(`Unsupported provider: ${account.type}`);
  }
}

function testFileName(): string {
  return `test-${Date.now()}.md`;
}

function textToBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function bufferToText(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

// ── Test suite per rule ──

describe.skipIf(!INTEGRATION)("Cloud Operations (integration)", () => {
  let settings: MultiSyncSettings;

  beforeAll(() => {
    settings = loadSettings();
    expect(settings.rules.length).toBeGreaterThan(0);
    expect(settings.accounts.length).toBeGreaterThan(0);
  });

  // Build a describe block per rule
  for (const ruleRef of (INTEGRATION ? loadSettings() : { rules: [] as SyncRule[], accounts: [] as CloudAccount[] }).rules) {
    const ruleId = ruleRef.id;

    describe(`Rule: ${ruleId}`, () => {
      let rule: SyncRule;
      let account: CloudAccount;
      let provider: ICloudProvider;
      const createdFiles: string[] = [];

      beforeAll(() => {
        settings = loadSettings();
        rule = settings.rules.find(r => r.id === ruleId)!;
        account = settings.accounts.find(a => a.id === rule.accountId)!;
        provider = createProvider(account);
        console.log(`Testing ${account.type} (${account.name}) — cloud: ${rule.cloudFolder}`);
      });

      afterAll(async () => {
        // Cleanup any leftover test files
        for (const f of createdFiles) {
          try { await provider.deleteFile(rule.cloudFolder, f); } catch {}
        }
      });

      it("testConnection", async () => {
        const ok = await provider.testConnection();
        expect(ok).toBe(true);
      });

      it("listFiles returns array", async () => {
        const files = await provider.listFiles(rule.cloudFolder);
        expect(Array.isArray(files)).toBe(true);
        console.log(`  listFiles: ${files.length} entries`);
      });

      // ── local-add: write file to cloud, verify it exists ──
      describe("local-add (write to cloud)", () => {
        const fileName = testFileName();

        afterAll(async () => { try { await provider.deleteFile(rule.cloudFolder, fileName); } catch {} });

        it("writes file to cloud", async () => {
          const content = textToBuffer(`local-add test ${Date.now()}`);
          await provider.writeFile(rule.cloudFolder, fileName, content, Date.now());
          createdFiles.push(fileName);
        });

        it("stat confirms file exists on cloud", async () => {
          const entry = await provider.stat(rule.cloudFolder, fileName);
          expect(entry).not.toBeNull();
          expect(entry!.path).toBe(fileName);
          expect(entry!.size).toBeGreaterThan(0);
        });

        it("readFile returns correct content", async () => {
          const buf = await provider.readFile(rule.cloudFolder, fileName);
          const text = bufferToText(buf);
          expect(text).toContain("local-add test");
        });

        it("listFiles includes the new file", async () => {
          const files = await provider.listFiles(rule.cloudFolder);
          const found = files.find(f => f.path === fileName);
          expect(found).toBeDefined();
        });
      });

      // ── local-delete: write then delete from cloud ──
      describe("local-delete (delete from cloud)", () => {
        const fileName = testFileName();

        it("creates file on cloud", async () => {
          await provider.writeFile(rule.cloudFolder, fileName, textToBuffer("delete me"), Date.now());
        });

        it("deletes file from cloud", async () => {
          await provider.deleteFile(rule.cloudFolder, fileName);
        });

        it("stat confirms file gone", async () => {
          const entry = await provider.stat(rule.cloudFolder, fileName);
          expect(entry).toBeNull();
        });

        it("listFiles no longer includes file", async () => {
          const files = await provider.listFiles(rule.cloudFolder);
          const found = files.find(f => f.path === fileName);
          expect(found).toBeUndefined();
        });
      });

      // ── cloud-add: write to cloud, read back (simulates download) ──
      describe("cloud-add (read from cloud)", () => {
        const fileName = testFileName();
        const expectedContent = `cloud-add content ${Date.now()}`;

        afterAll(async () => { try { await provider.deleteFile(rule.cloudFolder, fileName); } catch {} });

        it("creates file on cloud (simulating cloud-side creation)", async () => {
          await provider.writeFile(rule.cloudFolder, fileName, textToBuffer(expectedContent), Date.now());
          createdFiles.push(fileName);
        });

        it("readFile downloads correct content", async () => {
          const buf = await provider.readFile(rule.cloudFolder, fileName);
          expect(bufferToText(buf)).toBe(expectedContent);
        });
      });

      // ── cloud-update / local-update: mtime-based conflict ──
      describe("modify (mtime wins)", () => {
        const fileName = testFileName();
        const oldContent = "original content v1";
        const newContent = "modified content v2";

        afterAll(async () => { try { await provider.deleteFile(rule.cloudFolder, fileName); } catch {} });

        it("writes original file with old mtime", async () => {
          const oldTime = Date.now() - 60_000; // 1 min ago
          await provider.writeFile(rule.cloudFolder, fileName, textToBuffer(oldContent), oldTime);
          createdFiles.push(fileName);
        });

        it("overwrites with newer mtime (simulates local-update)", async () => {
          const newTime = Date.now();
          await provider.writeFile(rule.cloudFolder, fileName, textToBuffer(newContent), newTime);
        });

        it("reads back updated content", async () => {
          const buf = await provider.readFile(rule.cloudFolder, fileName);
          expect(bufferToText(buf)).toBe(newContent);
        });

        it("stat shows updated mtime is newer", async () => {
          const entry = await provider.stat(rule.cloudFolder, fileName);
          expect(entry).not.toBeNull();
          // mtime should be within last 10 seconds (accounting for API delay)
          expect(Date.now() - entry!.mtime).toBeLessThan(30_000);
        });
      });

      // ── cloud-delete detection via getDeletedItems ──
      describe("cloud-delete (delta detection)", () => {
        const fileName = testFileName();

        it("writes a file and gets baseline delta token", async () => {
          await provider.writeFile(rule.cloudFolder, fileName, textToBuffer("will be deleted"), Date.now());
          createdFiles.push(fileName);
          // Get baseline cursor
          const baseline = await provider.getDeletedItems(rule.cloudFolder, "");
          expect(baseline.newDeltaToken).toBeTruthy();
          console.log(`  baseline token: ${baseline.newDeltaToken.substring(0, 30)}...`);
          // Store token for next step — attach to provider instance for test continuity
          (provider as any).__testDeltaToken = baseline.newDeltaToken;
        });

        it("deletes the file from cloud", async () => {
          await provider.deleteFile(rule.cloudFolder, fileName);
          // Remove from cleanup list since we deleted it
          const idx = createdFiles.indexOf(fileName);
          if (idx >= 0) createdFiles.splice(idx, 1);
        });

        it("getDeletedItems detects the deletion", async () => {
          const token = (provider as any).__testDeltaToken;
          expect(token).toBeTruthy();

          // Small delay for cloud propagation
          await new Promise(r => setTimeout(r, 2000));

          const result = await provider.getDeletedItems(rule.cloudFolder, token);
          console.log(`  delta deleted: ${JSON.stringify(result.deleted)}`);
          expect(result.deleted).toContain(fileName);
          expect(result.newDeltaToken).toBeTruthy();
        });
      });
    });
  }
});
