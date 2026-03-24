/**
 * CDP Console Monitor — connects to Obsidian's debug port (9222)
 * and streams all console messages to logs/cdp-console.log
 * 
 * Usage: node tests/cdp-monitor.mjs
 * Stop:  Ctrl+C
 */
import { writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, "..", "logs");
const LOG_FILE = join(LOG_DIR, "cdp-console.log");

mkdirSync(LOG_DIR, { recursive: true });
writeFileSync(LOG_FILE, `=== CDP Monitor started at ${new Date().toISOString()} ===\n`);

function log(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}\n`;
  process.stdout.write(entry);
  appendFileSync(LOG_FILE, entry);
}

async function getWsUrl() {
  const resp = await fetch("http://127.0.0.1:9222/json");
  const targets = await resp.json();
  const page = targets.find(t => t.type === "page") || targets[0];
  if (!page) throw new Error("No CDP targets found");
  log(`Connected to: ${page.title} (${page.url})`);
  return page.webSocketDebuggerUrl;
}

async function monitor() {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  let msgId = 1;

  ws.addEventListener("open", () => {
    log("WebSocket connected — enabling Runtime + Log domains");
    ws.send(JSON.stringify({ id: msgId++, method: "Runtime.enable" }));
    ws.send(JSON.stringify({ id: msgId++, method: "Log.enable" }));
  });

  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);

    if (msg.method === "Runtime.consoleAPICalled") {
      const { type, args, timestamp } = msg.params;
      const text = args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(" ");
      log(`[console.${type}] ${text}`);
    }

    if (msg.method === "Runtime.exceptionThrown") {
      const ex = msg.params.exceptionDetails;
      const text = ex.exception?.description || ex.text || JSON.stringify(ex);
      log(`[EXCEPTION] ${text}`);
    }

    if (msg.method === "Log.entryAdded") {
      const { level, text, url } = msg.params.entry;
      log(`[log.${level}] ${text} ${url || ""}`);
    }
  });

  ws.addEventListener("close", () => {
    log("WebSocket closed — reconnecting in 3s...");
    setTimeout(monitor, 3000);
  });

  ws.addEventListener("error", (e) => {
    log(`WebSocket error: ${e.message || "unknown"}`);
  });
}

log("Connecting to CDP on port 9222...");
monitor().catch(e => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
