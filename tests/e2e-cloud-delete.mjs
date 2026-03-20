/**
 * Minimal cloud-delete debugging test.
 * Only tests cloud-delete for the first rule in data.json.
 * Usage: node tests/e2e-cloud-delete.mjs
 */
import http from "http";
import fs from "fs";
import path from "path";
import { WebSocket } from "undici";

const VAULT = process.env.VAULT_PATH || "D:\\obsidian";
const CDP_PORT = 9222;

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

let ws, msgId = 0;
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
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 120000);
    pending.set(id, (msg) => {
      clearTimeout(timeout);
      if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.exception?.description || "CDP eval error"));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr, awaitPromise = true) {
  const result = await cdpSend("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
  if (result.result?.type === "undefined") return undefined;
  return result.result?.value;
}

const PLUGIN = `app.plugins.plugins["obsidian-multisync"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function triggerSync() {
  return evaluate(`(async () => {
    const p = ${PLUGIN};
    let retries = 0;
    while (p.syncing && retries++ < 30) await new Promise(r => setTimeout(r, 1000));
    await p.runSync();
    retries = 0;
    while (p.syncing && retries++ < 60) await new Promise(r => setTimeout(r, 500));
    return "done";
  })()`, true);
}

async function main() {
  console.log("Connecting to Obsidian via CDP...");
  const pg = await getPage();
  await connect(pg.webSocketDebuggerUrl);
  console.log("Connected.\n");

  // Reload plugin for clean state
  await evaluate(`(async () => {
    await app.plugins.disablePlugin("obsidian-multisync");
    await app.plugins.enablePlugin("obsidian-multisync");
  })()`, true);
  await sleep(1000);
  console.log("Plugin reloaded.\n");

  // Enable console capture
  await evaluate(`(async () => {
    const p = ${PLUGIN};
    if (!p._testLogs) p._testLogs = [];
    const origLog = console.log;
    console.log = function(...args) {
      const msg = args.join(" ");
      if (msg.includes("[MultiSync]")) p._testLogs.push(msg);
      origLog.apply(console, args);
    };
  })()`, true);

  // Get first rule
  const settings = await evaluate(`JSON.parse(JSON.stringify(${PLUGIN}.settings))`);
  const rule = settings.rules[0];  // Test first rule (OneDrive)
  const account = settings.accounts.find(a => a.id === rule.accountId);
  console.log(`Rule: ${rule.id}`);
  console.log(`Provider: ${account.type} (${account.name})`);
  console.log(`Cloud: ${rule.cloudFolder}  ←→  Local: ${rule.localFolder}`);
  console.log(`Delta token: ${settings.deltaTokens?.[account.id] ? settings.deltaTokens[account.id].substring(0, 60) + "..." : "(none)"}`);

  const fname = `test-cloud-del-${Date.now()}.md`;
  const localFilePath = path.join(VAULT, rule.localFolder, fname);

  // Step 1: Write file to cloud
  console.log(`\n=== Step 1: Write "${fname}" to cloud ===`);
  await evaluate(`(async () => {
    const provider = ${PLUGIN}.providers.get("${account.id}");
    const buf = new TextEncoder().encode("cloud-delete test content").buffer;
    await provider.writeFile("${rule.cloudFolder}", "${fname}", buf, ${Date.now()});
    return "ok";
  })()`, true);
  console.log("  Written to cloud.");

  // Step 2: Sync #1 — file should appear locally
  console.log("\n=== Step 2: Sync #1 (cloud-add should pull file down) ===");
  await triggerSync();
  await sleep(2000);
  console.log(`  Local exists: ${fs.existsSync(localFilePath)}`);
  
  // Check delta token after sync #1
  const token1 = await evaluate(`${PLUGIN}.settings.deltaTokens?.["${account.id}"] || ""`);
  console.log(`  Delta token after sync#1: ${token1 ? token1.substring(0, 60) + "..." : "(none)"}`);

  // Step 3: Sync #2 — just to refresh cursor baseline
  console.log("\n=== Step 3: Sync #2 (refresh cursor baseline) ===");
  await triggerSync();
  await sleep(1000);
  
  const token2 = await evaluate(`${PLUGIN}.settings.deltaTokens?.["${account.id}"] || ""`);
  console.log(`  Delta token after sync#2: ${token2 ? token2.substring(0, 60) + "..." : "(none)"}`);
  console.log(`  Token changed: ${token1 !== token2}`);

  // Step 4: Delete file from cloud
  console.log(`\n=== Step 4: Delete "${fname}" from cloud ===`);
  await evaluate(`(async () => {
    const provider = ${PLUGIN}.providers.get("${account.id}");
    await provider.deleteFile("${rule.cloudFolder}", "${fname}");
    return "ok";
  })()`, true);
  console.log("  Deleted from cloud.");

  // Step 5: Wait for cloud to propagate, then check delta directly
  console.log("\n=== Step 5: Wait 5s, then check delta API directly ===");
  await sleep(5000);

  const deltaResult = await evaluate(`(async () => {
    const p = ${PLUGIN};
    const provider = p.providers.get("${account.id}");
    const token = p.settings.deltaTokens?.["${account.id}"] || "";
    const providerType = "${account.type}";
    let rawInfo = {};
    
    try {
      if (providerType === "dropbox") {
        const data = await provider.apiRpc("/files/list_folder/continue", { cursor: token });
        rawInfo = {
          entryCount: (data.entries || []).length,
          entries: (data.entries || []).map(e => ({ tag: e[".tag"], path: e.path_display, name: e.name })),
          has_more: data.has_more
        };
      } else if (providerType === "onedrive") {
        let url = token.startsWith("/") ? token : "/me/drive/root/delta(token='" + token + "')";
        const data = await provider.graphGetRaw(url);
        rawInfo = {
          valueCount: (data.value || []).length,
          entries: (data.value || []).map(e => e.deleted ? e : {
            name: e.name, deleted: false, id: e.id?.substring(0, 12),
            parentPath: e.parentReference?.path
          }),
          hasDeltaLink: !!data["@odata.deltaLink"],
          hasNextLink: !!data["@odata.nextLink"]
        };
      }
    } catch(e) {
      rawInfo = { error: e.message };
    }
    
    // Now call getDeletedItems  
    const result = await provider.getDeletedItems("${rule.cloudFolder}", token);
    return { 
      deleted: result.deleted, 
      newTokenPreview: result.newDeltaToken.substring(0, 60),
      rawInfo
    };
  })()`, true);

  console.log("  getDeletedItems result:", JSON.stringify(deltaResult?.deleted));
  console.log("  New token:", deltaResult?.newTokenPreview + "...");
  console.log("  Raw API response:", JSON.stringify(deltaResult?.rawInfo, null, 2));

  // Step 6: Sync #3 — should detect cloud-delete and remove local file
  console.log("\n=== Step 6: Sync #3 (should detect cloud-delete) ===");
  await triggerSync();
  await sleep(2000);

  const localStillExists = fs.existsSync(localFilePath);
  
  // Dump captured logs
  const logs = await evaluate(`${PLUGIN}._testLogs || []`);
  if (logs && logs.length > 0) {
    console.log("\n=== Plugin Logs ===");
    for (const log of logs) console.log("  ", log);
  }

  console.log(`\n=== RESULT: Local file still exists: ${localStillExists} ===`);
  if (localStillExists) {
    console.log("  ✗ FAIL — cloud-delete not working");
    
    // Extra debug: check what the pipeline saw
    const token3 = await evaluate(`${PLUGIN}.settings.deltaTokens?.["${account.id}"] || ""`);
    console.log(`  Delta token after sync#3: ${token3 ? token3.substring(0, 60) + "..." : "(none)"}`);
  } else {
    console.log("  ✓ PASS — file correctly deleted locally after cloud delete");
  }

  // Cleanup
  try { await evaluate(`(async () => { const p = ${PLUGIN}.providers.get("${account.id}"); await p.deleteFile("${rule.cloudFolder}", "${fname}"); })()`, true); } catch {}
  try { if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath); } catch {}

  ws.close();
}

main().catch(console.error);
