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

async function main() {
  const page = await getPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `JSON.stringify({
          accounts: app.plugins.plugins["obsidian-multisync"]?.settings?.accounts?.map(a => ({id:a.id, type:a.type, name:a.name})),
          rules: app.plugins.plugins["obsidian-multisync"]?.settings?.rules?.map(r => ({id:r.id, accountId:r.accountId, cloudFolder:r.cloudFolder})),
          deltaTokens: Object.entries(app.plugins.plugins["obsidian-multisync"]?.settings?.deltaTokens || {}).map(([k,v]) => ({key: k, len: v.length, start: v.substring(0,30)}))
        }, null, 2)`,
        returnByValue: true
      }
    }));
  });
  
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id === 1) {
      console.log(msg.result.result.value);
      ws.close();
      process.exit(0);
    }
  });
}

main().catch(e => { console.error(e); process.exit(1); });
