/**
 * E2E sync test for obsidian-multisync via CDP.
 *
 * Usage:
 *   node tests/e2e-test.mjs <vault-path>
 *   node tests/e2e-test.mjs C:\obsidian
 *
 * Reads first mapping from data.json, runs 4 test scenarios:
 *   1. Create file on cloud → sync → verify downloaded locally
 *   2. Delete cloud-created file locally → sync → verify deleted on cloud
 *   3. Create file locally → sync → verify uploaded to cloud
 *   4. Delete file on cloud → sync → verify deleted locally
 *
 * All test files use timestamp-based names and are cleaned up after.
 * No hardcoded paths or credentials.
 */
import http from "http";
import fs from "fs";
import path from "path";
import { WebSocket } from "undici";

// ── Config ──

const VAULT = process.argv[2];
if (!VAULT) {
  console.error("Usage: node tests/e2e-test.mjs <vault-path>");
  process.exit(1);
}

const CDP_PORT = 9222;
const SETTLE_MS = 3000;
const PLUGIN = `app.plugins.plugins["obsidian-multisync"]`;

// ── CDP helpers ──

let ws;
let msgId = 0;
const pending = new Map();

function getPage() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        const targets = JSON.parse(d);
        const p = targets.find((t) => t.url?.includes("obsidian.md/index"));
        p ? resolve(p) : reject(new Error("No Obsidian page found on CDP"));
      });
    }).on("error", reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
    ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
  });
}

function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 120_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.exception?.description || "CDP eval error"));
      } else {
        resolve(msg.result);
      }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await cdpSend("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.type === "undefined") return undefined;
  return r.result?.value;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Read config from plugin settings (first mapping) ──

async function readConfig() {
  const settings = await evaluate(
    `JSON.parse(JSON.stringify(${PLUGIN}.settings))`
  );
  if (!settings?.rules?.length) throw new Error("No rules/mappings in settings");
  const rule = settings.rules[0];
  const account = settings.accounts.find((a) => a.id === rule.accountId);
  if (!account) throw new Error(`Account ${rule.accountId} not found`);
  return { rule, account };
}

// ── Cloud operations (via CDP → provider) ──

async function createCloud(accountId, cloudFolder, relativePath, content, mtime) {
  return evaluate(`(async () => {
    const p = ${PLUGIN}.providers.get("${accountId}");
    if (!p) throw new Error("Provider not found");
    const buf = new TextEncoder().encode(${JSON.stringify(content)}).buffer;
    await p.writeFile("${cloudFolder}", "${relativePath}", buf, ${mtime});
    return "ok";
  })()`);
}

async function deleteCloud(accountId, cloudFolder, relativePath) {
  return evaluate(`(async () => {
    const p = ${PLUGIN}.providers.get("${accountId}");
    if (!p) throw new Error("Provider not found");
    await p.deleteFile("${cloudFolder}", "${relativePath}");
    return "ok";
  })()`);
}

async function verifyCloud(accountId, cloudFolder, relativePath) {
  return evaluate(`(async () => {
    const p = ${PLUGIN}.providers.get("${accountId}");
    if (!p) throw new Error("Provider not found");
    const entry = await p.stat("${cloudFolder}", "${relativePath}");
    return entry !== null;
  })()`);
}

async function readCloud(accountId, cloudFolder, relativePath) {
  return evaluate(`(async () => {
    const p = ${PLUGIN}.providers.get("${accountId}");
    if (!p) throw new Error("Provider not found");
    const buf = await p.readFile("${cloudFolder}", "${relativePath}");
    return new TextDecoder().decode(buf);
  })()`);
}

// ── Local operations ──

function localFilePath(localFolder, relativePath) {
  return path.join(VAULT, localFolder, relativePath);
}

async function createLocal(localFolder, relativePath, content) {
  const vaultPath = localFolder ? `${localFolder}/${relativePath}` : relativePath;
  return evaluate(`(async () => {
    const parts = "${vaultPath}".split("/");
    parts.pop();
    let dir = "";
    for (const part of parts) {
      dir = dir ? dir + "/" + part : part;
      if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
    }
    const existing = app.vault.getAbstractFileByPath("${vaultPath}");
    if (existing) {
      await app.vault.modify(existing, ${JSON.stringify(content)});
    } else {
      await app.vault.create("${vaultPath}", ${JSON.stringify(content)});
    }
    return "ok";
  })()`);
}

async function deleteLocal(localFolder, relativePath) {
  const vaultPath = localFolder ? `${localFolder}/${relativePath}` : relativePath;
  return evaluate(`(async () => {
    const file = app.vault.getAbstractFileByPath("${vaultPath}");
    if (!file) return "not-found";
    await app.vault.delete(file);
    return "deleted";
  })()`);
}

function verifyLocal(localFolder, relativePath) {
  return fs.existsSync(localFilePath(localFolder, relativePath));
}

function readLocal(localFolder, relativePath) {
  return fs.readFileSync(localFilePath(localFolder, relativePath), "utf-8");
}

// ── Sync (via CDP) ──

async function sync() {
  return evaluate(`(async () => {
    const p = ${PLUGIN};
    let retries = 0;
    while (p.syncing && retries++ < 30) await new Promise(r => setTimeout(r, 1000));
    await p.runSync();
    retries = 0;
    while (p.syncing && retries++ < 60) await new Promise(r => setTimeout(r, 500));
    return "done";
  })()`);
}

// ── Test framework ──

let passed = 0;
let failed = 0;
const failures = [];

function assert(ok, msg) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

// ── Test scenarios ──

async function testCloudAdd(cfg) {
  const { rule, account } = cfg;
  const ts = Date.now();
  const fname = `e2e-cloud-add-${ts}.md`;
  const content = `cloud-add-${ts}`;

  console.log(`\n── Test 1: cloud-add (${fname}) ──`);

  await createCloud(account.id, rule.cloudFolder, fname, content, ts);
  const exists = await verifyCloud(account.id, rule.cloudFolder, fname);
  assert(exists, "File created on cloud");

  await sync();
  await sleep(SETTLE_MS);

  assert(verifyLocal(rule.localFolder, fname), "File downloaded to local");
  if (verifyLocal(rule.localFolder, fname)) {
    assert(readLocal(rule.localFolder, fname) === content, "Content matches");
  }

  return fname;
}

async function testLocalDeleteAfterCloudAdd(cfg, fname) {
  const { rule, account } = cfg;

  console.log(`\n── Test 2: local-delete → cloud delete (${fname}) ──`);

  assert(verifyLocal(rule.localFolder, fname), "File exists locally before delete");

  await deleteLocal(rule.localFolder, fname);
  assert(!verifyLocal(rule.localFolder, fname), "File deleted locally");

  await sync();
  await sleep(SETTLE_MS);

  const cloudExists = await verifyCloud(account.id, rule.cloudFolder, fname);
  assert(!cloudExists, "File deleted from cloud after local delete");
}

async function testLocalAdd(cfg) {
  const { rule, account } = cfg;
  const ts = Date.now();
  const fname = `e2e-local-add-${ts}.md`;
  const content = `local-add-${ts}`;

  console.log(`\n── Test 3: local-add (${fname}) ──`);

  await createLocal(rule.localFolder, fname, content);
  assert(verifyLocal(rule.localFolder, fname), "File created locally");

  await sync();
  await sleep(SETTLE_MS);

  const cloudExists = await verifyCloud(account.id, rule.cloudFolder, fname);
  assert(cloudExists, "File uploaded to cloud");
  if (cloudExists) {
    const cloudContent = await readCloud(account.id, rule.cloudFolder, fname);
    assert(cloudContent === content, "Content matches on cloud");
  }

  return fname;
}

async function testCloudDeleteAfterLocalAdd(cfg, fname) {
  const { rule, account } = cfg;

  console.log(`\n── Test 4: cloud-delete → local delete (${fname}) ──`);

  assert(verifyLocal(rule.localFolder, fname), "File exists locally before cloud delete");

  await deleteCloud(account.id, rule.cloudFolder, fname);

  // Delta needs propagation time
  const waitMs = cfg.account.type === "dropbox" ? 15000 : 10000;
  console.log(`  Waiting ${waitMs / 1000}s for delta propagation...`);
  await sleep(waitMs);

  await sync();
  await sleep(SETTLE_MS);

  // GDrive changes API can be slow — retry once if still present
  if (verifyLocal(rule.localFolder, fname)) {
    console.log("  Retrying after additional wait...");
    await sleep(5000);
    await sync();
    await sleep(SETTLE_MS);
  }

  assert(!verifyLocal(rule.localFolder, fname), "File deleted locally after cloud delete");
}

// ── Main ──

async function main() {
  console.log("Connecting to Obsidian via CDP...\n");
  const page = await getPage();
  await connect(page.webSocketDebuggerUrl);
  await cdpSend("Runtime.enable");

  // Reload plugin to pick up latest build
  console.log("Reloading plugin...");
  await evaluate(`(async () => {
    await app.plugins.disablePlugin("obsidian-multisync");
    await new Promise(r => setTimeout(r, 500));
    await app.plugins.enablePlugin("obsidian-multisync");
    await new Promise(r => setTimeout(r, 1000));
    return "reloaded";
  })()`);
  console.log("Plugin reloaded.\n");

  // Auto-confirm delete prompts for automated testing
  await evaluate(`${PLUGIN}.autoConfirmDeletes = true`);

  const cfg = await readConfig();
  console.log(`Account: ${cfg.account.type} / ${cfg.account.name}`);
  console.log(`Mapping: ${cfg.rule.cloudFolder} ↔ ${cfg.rule.localFolder}\n`);

  // Reset registry and delta tokens to avoid stale data from prior runs
  console.log("Resetting registry and delta tokens...");
  await evaluate(`(async () => {
    const acctId = "${cfg.account.id}";
    // Clear IndexedDB registry
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("multisync-cloud-registry", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("accounts", "readwrite");
    tx.objectStore("accounts").delete(acctId);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    // Clear delta tokens
    const acct = ${PLUGIN}.settings.accounts.find(a => a.id === acctId);
    if (acct?.deltaTokens) {
      delete acct.deltaTokens["me"];
      await ${PLUGIN}.saveSettings();
    }
    return "done";
  })()`)
  console.log("Registry and delta tokens reset.\n");

  // Run tests sequentially — each depends on prior state
  try {
    // Test 1: Create on cloud → sync → verify local
    const cloudFile = await testCloudAdd(cfg);

    // Sync again to establish delta baseline for delete detection
    await sync();
    await sleep(SETTLE_MS);

    // Test 2: Delete locally → sync → verify cloud deleted
    await testLocalDeleteAfterCloudAdd(cfg, cloudFile);

    // Test 3: Create locally → sync → verify cloud
    const localFile = await testLocalAdd(cfg);

    // Sync again to establish delta baseline for delete detection
    await sync();
    await sleep(SETTLE_MS);

    // Test 4: Delete on cloud → sync → verify local deleted
    await testCloudDeleteAfterLocalAdd(cfg, localFile);
  } catch (err) {
    failed++;
    failures.push(`EXCEPTION: ${err.message}`);
    console.error(`\n  ✗ Exception: ${err.message}`);
  }

  // Reset autoConfirmDeletes so manual syncs get confirmation again
  await evaluate(`${PLUGIN}.autoConfirmDeletes = false`);

  // Summary
  console.log(`\n${"═".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }

  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
