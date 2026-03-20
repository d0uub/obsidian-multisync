// CDP helper: reload plugin, run sync, capture console output
const http = require('http');
const { WebSocket } = require('undici');

function getPage() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const targets = JSON.parse(data);
        const page = targets.find(t => t.url.includes('obsidian.md/index'));
        page ? resolve(page) : reject('No obsidian page');
      });
    }).on('error', reject);
  });
}

function cdp(wsUrl, expression, captureConsole = false, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const logs = [];
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; ws.close(); resolve({ logs, timeout: true }); } }, timeout);

    ws.addEventListener('open', async () => {
      if (captureConsole) {
        ws.send(JSON.stringify({ id: 99, method: 'Runtime.enable' }));
      }
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map(a => a.value || a.description || '').join(' ');
        if (text.includes('MultiSync') || text.includes('Dropbox') || text.includes('multisync') || text.includes('error') || text.includes('Error') || text.includes('rule-')) {
          logs.push(text);
          console.log(text);
        }
      }
      if (msg.id === 1 && !done) {
        // Wait a bit for trailing console messages
        setTimeout(() => {
          done = true;
          clearTimeout(timer);
          ws.close();
          resolve({ result: msg.result?.result?.value, logs });
        }, 2000);
      }
    });

    ws.addEventListener('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function main() {
  const page = await getPage();
  console.log('Connected:', page.title);

  // Step 1: Reload plugin
  console.log('\n=== Reloading plugin ===');
  const reloadResult = await cdp(page.webSocketDebuggerUrl,
    'app.commands.executeCommandById("app:reload")', false, 5000);

  // Wait for reload
  await new Promise(r => setTimeout(r, 5000));

  // Re-fetch page (wsUrl changes after reload)
  const page2 = await getPage();
  console.log('Reconnected:', page2.title);

  // Step 2: Run sync and capture output
  console.log('\n=== Running sync ===');
  const syncResult = await cdp(page2.webSocketDebuggerUrl, `
    (async () => {
      const p = app.plugins.plugins["obsidian-multisync"];
      if (!p) return "Plugin not loaded";
      try {
        await p.runSync();
        return "Sync completed";
      } catch(e) {
        return "Error: " + e.message + "\\n" + e.stack;
      }
    })()
  `, true, 60000);
  console.log('\n=== Result:', syncResult.result, '===');
  console.log('All captured logs:', syncResult.logs.length);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
