const http = require('http');
const { WebSocket } = require('undici');

http.get('http://127.0.0.1:9222/json', (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const targets = JSON.parse(data);
    const page = targets.find(t => t.url.includes('obsidian.md/index'));
    if (!page) { console.log('No obsidian page found'); process.exit(1); }
    
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let msgId = 0;
    const consoleLogs = [];
    
    function send(method, params = {}) {
      return new Promise((resolve) => {
        const id = ++msgId;
        ws.send(JSON.stringify({ id, method, params }));
        const handler = (event) => {
          const msg = JSON.parse(String(event.data));
          if (msg.id === id) {
            ws.removeEventListener('message', handler);
            resolve(msg.result);
          }
        };
        ws.addEventListener('message', handler);
      });
    }
    
    ws.addEventListener('open', async () => {
      // Enable console events
      await send('Runtime.enable');
      
      // Listen for console messages
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = msg.params.args.map(a => a.value || a.description || '').join(' ');
          if (text.includes('MultiSync')) {
            consoleLogs.push(text);
            console.log(text);
          }
        }
      });

      // Run sync 
      console.log('--- Starting sync ---');
      const syncResult = await send('Runtime.evaluate', {
        expression: `
          (async () => {
            const p = app.plugins.plugins["obsidian-multisync"];
            if (!p) return "Plugin not loaded";
            await p.runSync();
            return "Sync completed";
          })()
        `,
        awaitPromise: true,
        returnByValue: true
      });
      console.log('--- ' + syncResult.result.value + ' ---');
      
      // Wait a bit for any trailing console messages
      setTimeout(() => { ws.close(); process.exit(0); }, 3000);
    });
    ws.addEventListener('error', (e) => { console.error('WS error:', e); process.exit(1); });
  });
});
