// cc-htmlfeedback companion server (connected mode).
// Serves the app (static --root for now; --proxy added in Phase 4), injects the widget,
// exposes REST (POST/GET /__ccfb/tickets) + SSE (/__ccfb/events), and watches files:
//   feedback_tasks.json change  -> push a `tickets` event to the browser (page-scoped)
//   source file change -> push a `reload` event to the browser
// The session never speaks HTTP; it reads/writes the queue files directly.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { injectWidget } = require('./lib/inject.js');
const { QUEUE_DIR, pageKey, inboxPath, tasksPath, readTasks, upsertIndex, appendTicket, newTicket } = require('./lib/queue.js');

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png',
  '.ico':'image/x-icon', '.woff2':'font/woff2', '.map':'application/json' };

function startServer({ root, queueDir, port = 0, sessionId = crypto.randomUUID(), widgetPath, proxy } = {}) {
  fs.mkdirSync(queueDir, { recursive: true });
  root = path.resolve(root);
  widgetPath = widgetPath || path.join(__dirname, 'extension', 'feedback-widget.js');

  const sseClients = new Set();                      // each: { res, key }
  function broadcastTo(key, event, data){
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) if (c.key === key) { try { c.res.write(payload); } catch {} }
  }
  function broadcastAll(event, data){
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) { try { c.res.write(payload); } catch {} }
  }
  function sendJSON(res, code, obj){ res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj)); }

  // --proxy: forward to an existing dev server, injecting the widget into HTML responses
  // (so the upstream's own HMR keeps working). /__ccfb/* is always handled locally.
  function proxyRequest(req, res){
    const lib = proxy.startsWith('https:') ? require('node:https') : require('node:http');
    const target = new URL(req.url, proxy);
    const headers = Object.assign({}, req.headers, { host: target.host, 'accept-encoding': 'identity' });
    const up = lib.request(target, { method: req.method, headers }, upRes => {
      upRes.on('error', () => { try { res.destroy(); } catch {} });   // upstream dropped mid-response
      const ct = upRes.headers['content-type'] || '';
      if (ct.includes('text/html')) {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          const html = injectWidget(Buffer.concat(chunks).toString('utf8'), sessionId, 'proxy');
          const h = Object.assign({}, upRes.headers);
          delete h['content-length']; delete h['content-encoding']; delete h['transfer-encoding'];
          res.writeHead(upRes.statusCode, h);
          res.end(html);
        });
      } else {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        res.on('error', () => { try { upRes.destroy(); } catch {} });  // client dropped mid-pipe
      }
    });
    up.on('error', e => { try { res.writeHead(502); res.end('cc-htmlfeedback proxy error: ' + e.message); } catch {} });
    req.pipe(up);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/__ccfb/widget.js') {
      try { res.writeHead(200, {'content-type':'text/javascript'}); return res.end(fs.readFileSync(widgetPath)); }
      catch { res.writeHead(404); return res.end('widget not built — run `node build.js`'); }
    }
    if (p === '/__ccfb/tickets' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let fields; try { fields = JSON.parse(body); } catch { return sendJSON(res, 400, { error:'bad json' }); }
        const ticket = newTicket(fields);
        const key = pageKey(fields.page || '');
        upsertIndex(queueDir, key, fields.page || '');
        appendTicket(queueDir, key, ticket);   // shared write path (mkdir + append) — see lib/queue.js
        sendJSON(res, 200, ticket);
      });
      return;
    }
    if (p === '/__ccfb/tickets' && req.method === 'GET') {
      const key = pageKey(url.searchParams.get('page') || '');
      return sendJSON(res, 200, readTasks(queueDir, key));
    }
    if (p === '/__ccfb/clean' && req.method === 'POST') {
      let body = ''; req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let f; try { f = JSON.parse(body); } catch { return sendJSON(res, 400, { error:'bad json' }); }
        const key = pageKey(f.page || '');
        try {
          fs.mkdirSync(path.dirname(tasksPath(queueDir, key)), { recursive: true });
          fs.writeFileSync(inboxPath(queueDir, key), '');
          fs.writeFileSync(tasksPath(queueDir, key), JSON.stringify({ version:1, page: f.page || '', file:'', tickets:[] }));
        } catch (e) { return sendJSON(res, 500, { error: 'clean failed: ' + e.message }); }   // don't report false success
        broadcastTo(key, 'tickets', readTasks(queueDir, key));
        sendJSON(res, 200, { ok: true });
      });
      return;
    }
    if (p === '/__ccfb/events') {
      const key = pageKey(url.searchParams.get('page') || '');
      res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      res.write('retry: 2000\n\n');
      const client = { res, key }; sseClients.add(client);
      // Sync current board state to the just-connected (or reconnected) widget, so it
      // never sits on a stale "todo" if it missed a change event.
      try { client.res.write(`event: tickets\ndata: ${JSON.stringify(readTasks(queueDir, key))}\n\n`); } catch {}
      req.on('close', () => sseClients.delete(client));
      return;
    }

    if (proxy) return proxyRequest(req, res);

    // static file serving with HTML injection
    let rel = decodeURIComponent(p);
    let filePath = path.join(root, rel);
    if (p.endsWith('/')) filePath = path.join(filePath, 'index.html');
    if (path.relative(root, filePath).startsWith('..')) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(filePath, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(filePath);
      if (ext === '.html') {
        res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
        return res.end(injectWidget(buf.toString('utf8'), sessionId, 'static'));
      }
      res.writeHead(200, {'content-type': MIME[ext] || 'application/octet-stream'});
      res.end(buf);
    });
  });

  let reloadTimer = null;
  const watchers = [];
  function watchState(){
    // Poll the per-page boards instead of fs.watch: macOS recursive fs.watch does NOT
    // reliably fire for files inside subdirectories created AFTER the watch attaches, and
    // the pages/<key>/ dirs are created lazily on the first comment. Polling these small
    // JSON files every second is cheap and fully watch-independent.
    const pagesDir = path.join(queueDir, 'pages');
    const lastSeen = new Map();
    // prime=true on the startup pass records pre-existing boards WITHOUT broadcasting (so a
    // reconnecting client isn't spammed with stale state). On every later tick, any board that
    // is new OR changed is a real update worth pushing — including a page whose board is first
    // created after a client already connected (else that client would miss its first update).
    const tick = (prime) => {
      let keys; try { keys = fs.readdirSync(pagesDir); } catch { return; }
      for (const key of keys) {
        let cur;
        try { cur = fs.readFileSync(path.join(pagesDir, key, 'feedback_tasks.json'), 'utf8'); } catch { continue; }
        if (lastSeen.get(key) === cur) continue;
        lastSeen.set(key, cur);
        if (!prime) { try { broadcastTo(key, 'tickets', JSON.parse(cur)); } catch {} }
      }
    };
    tick(true);                               // prime existing state without broadcasting
    const id = setInterval(() => tick(false), 1000);
    watchers.push({ close: () => clearInterval(id) });
  }
  function watchSource(){
    const queueDirName = path.relative(root, queueDir);   // ignore our own queue writes, wherever the queue lives
    try { watchers.push(fs.watch(root, { recursive: true }, (_e, f) => {
      if (f && f.split(/[/\\]/).includes(queueDirName)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => broadcastAll('reload', { at: Date.now() }), 150);
    })); } catch {}
  }

  const handle = {
    get port(){ const a = server.address(); return a && a.port; },
    sessionId, broadcast: broadcastAll,
    close(){
      clearTimeout(reloadTimer);
      for (const w of watchers) { try { w.close(); } catch {} }
      for (const c of sseClients) { try { c.res.end(); } catch {} }
      server.close();
    },
  };
  // Resolve only once actually listening, so `.port` is valid and watchers are attached.
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => { watchState(); watchSource(); resolve(handle); });
  });
}

if (require.main === module) {
  const { values } = require('node:util').parseArgs({ options: {
    root: { type:'string', default:'.' },
    port: { type:'string', default:'4317' },
    proxy: { type:'string' },
  }});
  const root = path.resolve(values.root);          // still watched for reload, even in proxy mode
  const queueDir = path.join(root, QUEUE_DIR);
  startServer({ root, queueDir, port: Number(values.port), proxy: values.proxy }).then(h => {
    const how = values.proxy ? `proxy → ${values.proxy}` : `root: ${root}`;
    console.log(`cc-htmlfeedback server on http://127.0.0.1:${h.port} (${how})`);
  });
}

module.exports = { startServer };
