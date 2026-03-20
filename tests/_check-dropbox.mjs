import { WebSocket } from "undici";

// Get the Obsidian page WebSocket URL from CDP
const resp = await fetch("http://127.0.0.1:9222/json");
const targets = await resp.json();
const obsPage = targets.find(t => t.type === "page" && t.url.includes("obsidian"));
if (!obsPage) { console.error("No Obsidian page found"); process.exit(1); }

const ws = new WebSocket(obsPage.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));

let id = 1;
function send(method, params = {}) {
  return new Promise(r => {
    const i = id++;
    ws.addEventListener("message", function h(ev) {
      const d = JSON.parse(ev.data);
      if (d.id === i) { ws.removeEventListener("message", h); r(d); }
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

function evalJS(expr) {
  return new Promise(r => {
    const i = id++;
    ws.addEventListener("message", function h(ev) {
      const d = JSON.parse(ev.data);
      if (d.id === i) { ws.removeEventListener("message", h); r(d); }
    });
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}

const code = `(async () => {
  // Reload plugin to pick up latest build
  await app.plugins.disablePlugin('obsidian-multisync');
  await app.plugins.enablePlugin('obsidian-multisync');
  await new Promise(r => setTimeout(r, 2000));
  
  const p = app.plugins.plugins['obsidian-multisync'];

  // Capture console.log output
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => { 
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (msg.includes('MultiSync')) logs.push(msg);
    origLog(...args);
  };
  console.error = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (msg.includes('MultiSync')) logs.push('[ERROR] ' + msg);
    origErr(...args);
  };

  try {
    await p.runSync();
    console.log = origLog;
    console.error = origErr;
    return { success: true, logs };
  } catch(e) {
    console.log = origLog;
    console.error = origErr;
    return { error: e.message, logs };
  }
})()`;

const res = await evalJS(code);
console.log("Result:", JSON.stringify(res.result?.result?.value, null, 2));
ws.close();
