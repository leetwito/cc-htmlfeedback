// cc-htmlfeedback companion server (connected mode).
// Serves the app (static --root for now; --proxy added in Phase 4), injects the widget,
// exposes REST (POST/GET /__ccfb/tickets) + SSE (/__ccfb/events), and watches files:
//   state.json change  -> push a `tickets` event to the browser
//   source file change -> push a `reload` event to the browser
// The session never speaks HTTP; it reads/writes the queue files directly.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { injectWidget } = require('./lib/inject.js');
const { QUEUE_DIR, inboxPath, statePath, newTicket } = require('./lib/queue.js');

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png',
  '.ico':'image/x-icon', '.woff2':'font/woff2', '.map':'application/json' };

function startServer({ root, queueDir, port = 0, sessionId = crypto.randomUUID(), widgetPath, proxy } = {}) {
  fs.mkdirSync(queueDir, { recursive: true });
  root = path.resolve(root);
  widgetPath = widgetPath || path.join(__dirname, 'extension', 'feedback-widget.js');
  const sseClients = new Set();

  function broadcast(event, data){
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) { try { res.write(payload); } catch {} }
  }
  function sendJSON(res, code, obj){ res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj)); }

  // --proxy: forward to an existing dev server, injecting the widget into HTML responses
  // (so the upstream's own HMR keeps working). /__ccfb/* is always handled locally.
  function proxyRequest(req, res){
    const lib = proxy.startsWith('https:') ? require('node:https') : require('node:http');
    const target = new URL(req.url, proxy);
    const headers = Object.assign({}, req.headers, { host: target.host, 'accept-encoding': 'identity' });
    const up = lib.request(target, { method: req.method, headers }, upRes => {
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
      }
    });
    up.on('error', e => { res.writeHead(502); res.end('cc-htmlfeedback proxy error: ' + e.message); });
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
        fs.appendFileSync(inboxPath(queueDir), JSON.stringify(ticket) + '\n');
        sendJSON(res, 200, ticket);
      });
      return;
    }
    if (p === '/__ccfb/tickets' && req.method === 'GET') {
      try { return sendJSON(res, 200, JSON.parse(fs.readFileSync(statePath(queueDir), 'utf8'))); }
      catch { return sendJSON(res, 200, { version:1, tickets:[] }); }
    }
    if (p === '/__ccfb/events') {
      res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
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
    try { watchers.push(fs.watch(queueDir, (_e, f) => {
      if (f === 'state.json') {
        try { broadcast('tickets', JSON.parse(fs.readFileSync(statePath(queueDir),'utf8'))); } catch {}
      }
    })); } catch {}
  }
  function watchSource(){
    try { watchers.push(fs.watch(root, { recursive: true }, (_e, f) => {
      if (f && f.split(path.sep).includes(QUEUE_DIR)) return; // ignore our own queue writes
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => broadcast('reload', { at: Date.now() }), 150);
    })); } catch {}
  }

  const handle = {
    get port(){ const a = server.address(); return a && a.port; },
    sessionId, broadcast,
    close(){
      clearTimeout(reloadTimer);
      for (const w of watchers) { try { w.close(); } catch {} }
      for (const r of sseClients) { try { r.end(); } catch {} }
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
