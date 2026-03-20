/**
 * CDP-driven E2E test for obsidian-multisync.
 * Tests all 6 sync operations per rule in data.json.
 * Uses Obsidian's live providers (via CDP) and local filesystem.
 *
 * Usage: node tests/e2e-sync.mjs
 */
import http from "http";
import fs from "fs";
import path from "path";
import { WebSocket } from "undici";

const VAULT = process.env.VAULT_PATH || "D:\\obsidian";
const CDP_PORT = 9222;
const SETTLE_MS = 2000; // wait for cloud propagation

// ── CDP helpers ──

function getPage() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        const targets = JSON.parse(d);
        const p = targets.find((t) => t.url.includes("obsidian.md/index"));
        p ? resolve(p) : reject(new Error("No Obsidian page found"));
      });
    }).on("error", reject);
  });
}

let ws;
let msgId = 0;
const pending = new Map();

function connect(wsUrl) {
  return new Promise((resolve) => {
    ws = new WebSocket(wsUrl);
    ws.addEventListener("open", resolve);
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
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 120000);
    pending.set(id, (msg) => {
      clearTimeout(timeout);
      if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.exception?.description || "CDP eval error"));
      } else {
        resolve(msg.result);
      }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr, awaitPromise = true) {
  const result = await cdpSend("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise,
  });
  if (result.result?.type === "undefined") return undefined;
  return result.result?.value;
}

// ── Plugin helpers via CDP ──

const PLUGIN = `app.plugins.plugins["obsidian-multisync"]`;

async function getSettings() {
  return evaluate(`JSON.parse(JSON.stringify(${PLUGIN}.settings))`);
}

async function reloadPlugin() {
  await evaluate(`(async () => {
    await ${PLUGIN}.app.plugins.disablePlugin("obsidian-multisync");
    await ${PLUGIN}.app.plugins.enablePlugin("obsidian-multisync");
  })()`, true);
  await sleep(1000);
}

async function triggerSync() {
  // Wait until not syncing, then trigger
  const result = await evaluate(`(async () => {
    const p = ${PLUGIN};
    // Wait if already syncing
    let retries = 0;
    while (p.syncing && retries++ < 30) await new Promise(r => setTimeout(r, 1000));
    await p.runSync();
    // Wait for sync to complete
    retries = 0;
    while (p.syncing && retries++ < 60) await new Promise(r => setTimeout(r, 500));
    return "done";
  })()`, true);
  return result;
}

async function cloudListFiles(accountId, cloudFolder) {
  return evaluate(`(async () => {
    const provider = ${PLUGIN}.providers.get("${accountId}");
    if (!provider) throw new Error("Provider not found: ${accountId}");
    const files = await provider.listFiles("${cloudFolder}");
    return files.map(f => ({path: f.path, mtime: f.mtime, size: f.size, isFolder: f.isFolder}));
  })()`, true);
}

async function cloudWriteFile(accountId, cloudFolder, relativePath, content, mtime) {
  return evaluate(`(async () => {
    const provider = ${PLUGIN}.providers.get("${accountId}");
    const encoder = new TextEncoder();
    const buf = encoder.encode(${JSON.stringify(content)}).buffer;
    await provider.writeFile("${cloudFolder}", "${relativePath}", buf, ${mtime});
    return "ok";
  })()`, true);
}

async function cloudReadFile(accountId, cloudFolder, relativePath) {
  return evaluate(`(async () => {
    const provider = ${PLUGIN}.providers.get("${accountId}");
    const buf = await provider.readFile("${cloudFolder}", "${relativePath}");
    return new TextDecoder().decode(buf);
  })()`, true);
}

async function cloudDeleteFile(accountId, cloudFolder, relativePath) {
  return evaluate(`(async () => {
    const provider = ${PLUGIN}.providers.get("${accountId}");
    await provider.deleteFile("${cloudFolder}", "${relativePath}");
    return "ok";
  })()`, true);
}

async function cloudStat(accountId, cloudFolder, relativePath) {
  return evaluate(`(async () => {
    const provider = ${PLUGIN}.providers.get("${accountId}");
    const entry = await provider.stat("${cloudFolder}", "${relativePath}");
    return entry ? {path: entry.path, mtime: entry.mtime, size: entry.size} : null;
  })()`, true);
}

// ── Local FS helpers ──

function localPath(localFolder, relativePath) {
  return path.join(VAULT, localFolder, relativePath);
}

function localExists(localFolder, relativePath) {
  return fs.existsSync(localPath(localFolder, relativePath));
}

function localWrite(localFolder, relativePath, content) {
  const p = localPath(localFolder, relativePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

/** Write file via Obsidian vault adapter (so vault index is updated) */
async function localWriteViaVault(localFolder, relativePath, content) {
  const vaultPath = localFolder ? `${localFolder}/${relativePath}` : relativePath;
  return evaluate(`(async () => {
    // Ensure parent folders exist
    const parts = "${vaultPath}".split("/");
    parts.pop(); // remove filename
    let dir = "";
    for (const part of parts) {
      dir = dir ? dir + "/" + part : part;
      if (!app.vault.getAbstractFileByPath(dir)) {
        await app.vault.createFolder(dir);
      }
    }
    const existing = app.vault.getAbstractFileByPath("${vaultPath}");
    if (existing) {
      await app.vault.modify(existing, ${JSON.stringify(content)});
    } else {
      await app.vault.create("${vaultPath}", ${JSON.stringify(content)});
    }
    return "ok";
  })()`, true);
}

function localRead(localFolder, relativePath) {
  return fs.readFileSync(localPath(localFolder, relativePath), "utf-8");
}

function localDelete(localFolder, relativePath) {
  // Don't use fs.unlinkSync — Obsidian's vault watcher won't see it.
  // Use CDP to delete via Obsidian's vault adapter so the delete event fires.
  // This is handled by localDeleteViaVault() below.
  const p = localPath(localFolder, relativePath);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** Delete a file via Obsidian's vault (so the delete event fires for pending cloud deletes) */
async function localDeleteViaVault(localFolder, relativePath) {
  const vaultPath = localFolder ? `${localFolder}/${relativePath}` : relativePath;
  return evaluate(`(async () => {
    const file = app.vault.getAbstractFileByPath("${vaultPath}");
    if (!file) return "not-found";
    await app.vault.delete(file);
    return "deleted";
  })()`, true);
}

function localMtime(localFolder, relativePath) {
  return fs.statSync(localPath(localFolder, relativePath)).mtimeMs;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Test runner ──

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (!condition) {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  } else {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

// Parse --only flag: e.g. --only cloud-delete or --only local-add,cloud-add
const onlyArg = process.argv.find(a => a.startsWith("--only="))?.split("=")[1]
  || (process.argv.indexOf("--only") >= 0 ? process.argv[process.argv.indexOf("--only") + 1] : null);
const onlyOps = onlyArg ? onlyArg.split(",").map(s => s.trim()) : null;

async function testRule(rule, account) {
  const { id: ruleId, cloudFolder, localFolder, accountId } = rule;
  const tag = `[${account.type}/${account.name}]`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`${tag} Testing rule: ${ruleId}`);
  console.log(`  cloud: ${cloudFolder}  ↔  local: ${localFolder}`);
  console.log(`${"═".repeat(60)}`);

  const ts = Date.now();
  const cleanup = [];

  try {
    // ── 1. local-add: create local file → sync → verify on cloud ──
    if (!onlyOps || onlyOps.includes("local-add")) {
      const fname = `test-local-add-${ts}.md`;
      console.log(`\n── local-add: ${fname} ──`);
      await localWriteViaVault(localFolder, fname, `local-add content ${ts}`);
      cleanup.push({ type: "local", path: fname });
      cleanup.push({ type: "cloud", path: fname });

      await triggerSync();
      await sleep(SETTLE_MS);

      const cloudEntry = await cloudStat(accountId, cloudFolder, fname);
      assert(cloudEntry !== null, `${tag} local-add: file exists on cloud`);
      if (cloudEntry) {
        const content = await cloudReadFile(accountId, cloudFolder, fname);
        assert(content === `local-add content ${ts}`, `${tag} local-add: content matches`);
      } else {
        // Debug: list what IS on cloud
        const cloudFiles = await cloudListFiles(accountId, cloudFolder);
        const testFiles = cloudFiles.filter(f => f.path.includes("test-local-add"));
        console.log(`    Cloud test files: ${JSON.stringify(testFiles.map(f=>f.path))}`);
      }
    }

    // ── 2. cloud-add: create file on cloud → sync → verify locally ──
    if (!onlyOps || onlyOps.includes("cloud-add")) {
      const fname = `test-cloud-add-${ts}.md`;
      console.log(`\n── cloud-add: ${fname} ──`);
      await cloudWriteFile(accountId, cloudFolder, fname, `cloud-add content ${ts}`, ts);
      cleanup.push({ type: "cloud", path: fname });
      cleanup.push({ type: "local", path: fname });

      await triggerSync();
      await sleep(SETTLE_MS);

      assert(localExists(localFolder, fname), `${tag} cloud-add: file exists locally`);
      if (localExists(localFolder, fname)) {
        const content = localRead(localFolder, fname);
        assert(content === `cloud-add content ${ts}`, `${tag} cloud-add: content matches`);
      }
    }

    // ── 3. local-update: modify local (newer mtime) → sync → cloud gets update ──
    if (!onlyOps || onlyOps.includes("local-update")) {
      const fname = `test-modify-${ts}.md`;
      console.log(`\n── local-update: ${fname} ──`);
      // Create initial file on both sides via cloud write + sync
      const oldTime = ts - 120_000;
      await cloudWriteFile(accountId, cloudFolder, fname, "original v1", oldTime);
      cleanup.push({ type: "cloud", path: fname });
      cleanup.push({ type: "local", path: fname });

      await triggerSync();
      await sleep(SETTLE_MS);
      assert(localExists(localFolder, fname), `${tag} local-update: initial file synced locally`);

      // Now modify locally with newer content via vault API
      await localWriteViaVault(localFolder, fname, "modified local v2");

      await triggerSync();
      await sleep(SETTLE_MS);

      const cloudContent = await cloudReadFile(accountId, cloudFolder, fname);
      assert(cloudContent === "modified local v2", `${tag} local-update: cloud has new content`);
    }

    // ── 4. cloud-update: modify on cloud (newer mtime) → sync → local gets update ──
    if (!onlyOps || onlyOps.includes("cloud-update")) {
      const fname = `test-cloud-mod-${ts}.md`;
      console.log(`\n── cloud-update: ${fname} ──`);
      // Create initial on cloud + sync to local
      const oldTime = ts - 120_000;
      await cloudWriteFile(accountId, cloudFolder, fname, "original cloud v1", oldTime);
      cleanup.push({ type: "cloud", path: fname });
      cleanup.push({ type: "local", path: fname });

      await triggerSync();
      await sleep(SETTLE_MS);
      assert(localExists(localFolder, fname), `${tag} cloud-update: initial file synced locally`);

      // Overwrite on cloud with newer mtime
      await cloudWriteFile(accountId, cloudFolder, fname, "modified cloud v2", Date.now());

      await triggerSync();
      await sleep(SETTLE_MS);

      if (localExists(localFolder, fname)) {
        const content = localRead(localFolder, fname);
        assert(content === "modified cloud v2", `${tag} cloud-update: local has new content`);
      } else {
        assert(false, `${tag} cloud-update: local file missing after sync`);
      }
    }

    // ── 5. local-delete: delete local file → sync → cloud file deleted ──
    if (!onlyOps || onlyOps.includes("local-delete")) {
      const fname = `test-local-del-${ts}.md`;
      console.log(`\n── local-delete: ${fname} ──`);
      // Create file on both sides
      await localWriteViaVault(localFolder, fname, "will be deleted locally");
      cleanup.push({ type: "cloud", path: fname });

      await triggerSync();
      await sleep(SETTLE_MS);

      const beforeCloud = await cloudStat(accountId, cloudFolder, fname);
      assert(beforeCloud !== null, `${tag} local-delete: file on cloud before delete`);

      // Delete locally via Obsidian vault (so the delete event listener tracks it)
      await localDeleteViaVault(localFolder, fname);

      await triggerSync();
      await sleep(SETTLE_MS);

      const afterCloud = await cloudStat(accountId, cloudFolder, fname);
      assert(afterCloud === null, `${tag} local-delete: file removed from cloud`);
    }

    // ── 6. cloud-delete: delete on cloud → sync → local file deleted ──
    if (!onlyOps || onlyOps.includes("cloud-delete")) {
      const fname = `test-cloud-del-${ts}.md`;
      console.log(`\n── cloud-delete: ${fname} ──`);
      // Create on cloud + sync to local
      await cloudWriteFile(accountId, cloudFolder, fname, "will be deleted from cloud", ts);
      cleanup.push({ type: "local", path: fname });

      await triggerSync();
      await sleep(SETTLE_MS);
      assert(localExists(localFolder, fname), `${tag} cloud-delete: file synced locally before delete`);

      // Establish delta baseline (the first sync after file creation already did this,
      // but we need a fresh cursor AFTER the file exists)
      // Trigger another sync to refresh the delta token
      await triggerSync();
      await sleep(SETTLE_MS);

      // Now delete from cloud
      await cloudDeleteFile(accountId, cloudFolder, fname);
      // Delta API needs time for deletion to propagate (Dropbox can take 5-15s)
      const delWait = account.type === "dropbox" ? 15000 : 5000;
      console.log(`    Waiting ${delWait/1000}s for delta propagation...`);
      await sleep(delWait);

      // Check delta directly before sync — dump raw API response
      const deltaCheck = await evaluate(`(async () => {
        const p = ${PLUGIN};
        const provider = p.providers.get("${accountId}");
        const token = p.settings.deltaTokens?.["${accountId}"] || "";
        const providerType = "${account.type}";
        let rawInfo = {};
        
        if (providerType === "dropbox") {
          // Raw Dropbox list_folder/continue
          try {
            const data = await provider.apiRpc("/files/list_folder/continue", { cursor: token });
            rawInfo = {
              entryCount: (data.entries || []).length,
              entries: (data.entries || []).slice(0, 10).map(e => ({ tag: e[".tag"], path: e.path_display })),
              has_more: data.has_more
            };
          } catch(e) { rawInfo = { error: e.message }; }
        } else if (providerType === "onedrive") {
          // Raw OneDrive delta call
          try {
            let url = token.startsWith("/") ? token : "/me/drive/root/delta(token='" + token + "')";
            const data = await provider.graphGetRaw(url);
            rawInfo = {
              valueCount: (data.value || []).length,
              entries: (data.value || []).slice(0, 10).map(e => ({
                name: e.name,
                deleted: !!e.deleted,
                id: e.id?.substring(0, 10),
                parentPath: e.parentReference?.path
              })),
              hasDeltaLink: !!data["@odata.deltaLink"],
              hasNextLink: !!data["@odata.nextLink"]
            };
          } catch(e) { rawInfo = { error: e.message }; }
        }
        
        const result = await provider.getDeletedItems("${cloudFolder}", token);
        return { 
          deleted: result.deleted, 
          hasToken: !!token, 
          tokenPreview: token.substring(0, 80),
          rawInfo
        };
      })()`, true);
      console.log("    Delta check:", JSON.stringify(deltaCheck, null, 2));

      await triggerSync();
      await sleep(SETTLE_MS);

      const stillExists = localExists(localFolder, fname);
      assert(!stillExists, `${tag} cloud-delete: local file removed after cloud delete`);
      if (stillExists) {
        console.log(`    (local file still at: ${localPath(localFolder, fname)})`);
      }
    }
  } catch (err) {
    failed++;
    failures.push(`${tag} EXCEPTION: ${err.message}`);
    console.error(`  ✗ Exception:`, err.message);
  }

  // Cleanup
  console.log(`\n  Cleaning up...`);
  for (const item of cleanup) {
    try {
      if (item.type === "cloud") {
        await cloudDeleteFile(accountId, cloudFolder, item.path);
      } else {
        localDelete(localFolder, item.path);
      }
    } catch {}
  }
}

// ── Main ──

async function main() {
  console.log("Connecting to Obsidian via CDP...");
  const page = await getPage();
  await connect(page.webSocketDebuggerUrl);
  console.log("Connected.\n");

  // Enable console + Runtime domain  
  await cdpSend("Runtime.enable");
  await cdpSend("Console.enable");

  // Capture console errors from Obsidian
  const consoleErrors = [];
  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(String(evt.data));
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      const text = msg.params.args?.map(a => a.value || a.description || "").join(" ") || "";
      if (text.includes("MultiSync")) consoleErrors.push(text);
    }
  });

  // Reload plugin to pick up latest code
  console.log("Reloading plugin...");
  await evaluate(`(async () => {
    await app.plugins.disablePlugin("obsidian-multisync");
    await new Promise(r => setTimeout(r, 500));
    await app.plugins.enablePlugin("obsidian-multisync");
    await new Promise(r => setTimeout(r, 1000));
    return "reloaded";
  })()`, true);
  console.log("Plugin reloaded.\n");

  const settings = await getSettings();
  console.log(`Found ${settings.accounts.length} account(s), ${settings.rules.length} rule(s)\n`);

  // Ensure cloud test folders exist
  for (const rule of settings.rules) {
    const account = settings.accounts.find((a) => a.id === rule.accountId);
    if (!account) continue;
    console.log(`Ensuring cloud folder "${rule.cloudFolder}" exists for ${account.type}...`);
    try {
      await evaluate(`(async () => {
        const provider = ${PLUGIN}.providers.get("${account.id}");
        if (!provider) throw new Error("No provider for ${account.id}");
        await provider.mkdir("", "${rule.cloudFolder}");
        return "ok";
      })()`, true);
    } catch (e) {
      console.log(`  (mkdir might already exist: ${e.message})`);
    }
  }
  console.log("");

  for (const rule of settings.rules) {
    const account = settings.accounts.find((a) => a.id === rule.accountId);
    if (!account) {
      console.log(`Skipping rule ${rule.id}: account ${rule.accountId} not found`);
      continue;
    }
    await testRule(rule, account);
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  if (consoleErrors.length > 0) {
    console.log(`\nConsole Errors (${consoleErrors.length}):`);
    for (const e of consoleErrors) console.log(`  ! ${e}`);
  }
  console.log(`${"═".repeat(60)}`);

  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
