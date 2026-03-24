/**
 * Simple CDP sync test — triggers a sync and captures DevTools console output.
 *
 * Usage:
 *   node tests/cdp-sync.mjs
 */
import http from "http";
import { WebSocket } from "undici";

const CDP_PORT = 9222;
const PLUGIN = 'app.plugins.plugins["multisync"]';
let ws, msgId = 0;
const pending = new Map();

function discoverWsUrl() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const targets = JSON.parse(data);
        // Find the main Obsidian window (has "app" in title or is the first page)
        const t = targets.find((t) => t.url && t.url.startsWith("app://")) || targets.find((t) => t.type === "page") || targets[0];
        resolve(t.webSocketDebuggerUrl);
      });
    }).on("error", reject);
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

// ── Main ──
const wsUrl = await discoverWsUrl();
console.log("Connecting to Obsidian CDP...");
ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener("open", r));
ws.addEventListener("message", (evt) => {
  const msg = JSON.parse(String(evt.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  // Print console messages from the page
  if (msg.method === "Runtime.consoleAPICalled") {
    const args = msg.params.args.map(a => a.value ?? a.description ?? "").join(" ");
    const type = msg.params.type; // log, warn, error, info
    const prefix = type === "error" ? "ERR" : type === "warning" ? "WRN" : "LOG";
    console.log(`  [${prefix}] ${args}`);
  }
});

// Enable console capture
await cdpSend("Runtime.enable");
// Clear buffered console messages by disabling and re-enabling
await cdpSend("Runtime.disable");
await cdpSend("Runtime.enable");

// Reset registry and delta tokens first
const acctId = await evaluate(`${PLUGIN}.settings.accounts[0].id`);
console.log(`Account: ${acctId}`);
await evaluate(`(async () => {
  const acctId = "${acctId}";
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
  const acct = ${PLUGIN}.settings.accounts.find(a => a.id === acctId);
  if (acct?.deltaTokens) {
    delete acct.deltaTokens["me"];
    await ${PLUGIN}.saveSettings();
  }
  return "done";
})()`);
console.log("Registry reset.\n");

console.log("Running sync...\n");
await evaluate(`(async () => {
  const p = ${PLUGIN};
  let retries = 0;
  while (p.syncing && retries++ < 30) await new Promise(r => setTimeout(r, 1000));
  await p.runSync();
  retries = 0;
  while (p.syncing && retries++ < 60) await new Promise(r => setTimeout(r, 500));
  return "done";
})()`);

console.log("\nSync complete.");
ws.close();
