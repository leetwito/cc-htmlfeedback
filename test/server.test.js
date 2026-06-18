const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../server.js');
const { pageKey, inboxPath, tasksPath } = require('../lib/queue.js');

function tmpRoot(){ return fs.mkdtempSync(path.join(os.tmpdir(), 'ccfb-root-')); }

async function start(){
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'index.html'), '<html><body>hello</body></html>');
  fs.writeFileSync(path.join(root, 'widget.stub.js'), '/* stub */');
  const queueDir = path.join(root, '.cc-htmlfeedback');
  const srv = await startServer({ root, queueDir, port: 0, sessionId: 'SID', widgetPath: path.join(root, 'widget.stub.js') });
  const base = `http://127.0.0.1:${srv.port}`;
  return { base, queueDir, srv, close: () => srv.close() };
}

test('serves root HTML with widget injected, and POST appends a ticket', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'index.html'), '<html><body>hello</body></html>');
  fs.writeFileSync(path.join(root, 'widget.stub.js'), '/* stub */');
  const queueDir = path.join(root, '.cc-htmlfeedback');
  const srv = await startServer({ root, queueDir, port: 0, sessionId: 'SID', widgetPath: path.join(root, 'widget.stub.js') });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const page = await (await fetch(base + '/')).text();
    assert.ok(page.includes('/__ccfb/widget.js'), 'widget injected');
    assert.ok(page.includes('"SID"'), 'sessionId injected');

    const pageUrl = base + '/';
    const res = await fetch(base + '/__ccfb/tickets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'make it blue', page: pageUrl }),
    });
    assert.equal(res.status, 200);
    const ticket = await res.json();
    assert.equal(ticket.status, 'todo');

    const key = pageKey(pageUrl);
    const inbox = inboxPath(queueDir, key);
    const lines = fs.readFileSync(inbox, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).note, 'make it blue');

    const widget = await (await fetch(base + '/__ccfb/widget.js')).text();
    assert.ok(widget.includes('stub'));

    const state = await (await fetch(base + '/__ccfb/tickets?page=' + encodeURIComponent(pageUrl))).json();
    assert.deepEqual(state, { version: 1, page: '', file: '', tickets: [] });
  } finally {
    srv.close();
  }
});

test('--proxy injects the widget into upstream HTML and passes other content through', async () => {
  const http = require('node:http');
  // stub upstream dev server
  const upstream = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, {'content-type':'text/javascript'}); return res.end('console.log(1)'); }
    res.writeHead(200, {'content-type':'text/html'}); res.end('<html><body>UPSTREAM</body></html>');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const root = tmpRoot();
  const queueDir = path.join(root, '.cc-htmlfeedback');
  const srv = await startServer({ root, queueDir, port: 0, sessionId: 'SID', widgetPath: __filename, proxy: `http://127.0.0.1:${upPort}` });
  const base = `http://127.0.0.1:${srv.port}`;
  const pageUrl = base + '/';
  try {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('UPSTREAM'), 'served upstream HTML');
    assert.ok(html.includes('/__ccfb/widget.js'), 'widget injected into proxied HTML');

    const js = await (await fetch(base + '/app.js')).text();
    assert.equal(js, 'console.log(1)', 'non-HTML passes through untouched');

    // /__ccfb/* stays local even in proxy mode
    const state = await (await fetch(base + '/__ccfb/tickets?page=' + encodeURIComponent(pageUrl))).json();
    assert.deepEqual(state, { version: 1, page: '', file: '', tickets: [] });
  } finally {
    srv.close(); upstream.close();
  }
});

test('SSE pushes a tickets event when feedback_tasks.json changes', async () => {
  const root = tmpRoot();
  const queueDir = path.join(root, '.cc-htmlfeedback');
  const srv = await startServer({ root, queueDir, port: 0, sessionId: 'SID', widgetPath: __filename });
  const base = `http://127.0.0.1:${srv.port}`;
  const pageUrl = base + '/sse-test.html';
  const key = pageKey(pageUrl);
  try {
    const ctrl = new AbortController();
    const resp = await fetch(base + '/__ccfb/events?page=' + encodeURIComponent(pageUrl), { signal: ctrl.signal });
    const reader = resp.body.getReader();
    // give the watcher a tick, then write feedback_tasks.json
    await new Promise(r => setTimeout(r, 100));
    const tPath = tasksPath(queueDir, key);
    fs.mkdirSync(path.dirname(tPath), { recursive: true });
    fs.writeFileSync(tPath,
      JSON.stringify({ version: 1, page: pageUrl, file: '/sse-test.html', tickets: [{ id: 'x', status: 'done', note: 'n' }] }));
    let buf = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      // The server sends an initial (empty) tickets resync on connect, so don't stop on the
      // first `event: tickets` — wait until the board state we wrote is actually broadcast.
      if (buf.includes('"done"')) break;
    }
    ctrl.abort();
    assert.ok(buf.includes('event: tickets'), 'received tickets SSE event');
    assert.ok(buf.includes('"done"'), 'event carried the state');
  } finally {
    srv.close();
  }
});

test('POST routes a comment to its page board; GET ?page returns it', async () => {
  const { base, queueDir, close } = await start();
  const page = base + '/a.html';
  await fetch(base + '/__ccfb/tickets', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ type:'comment', quote:'x', note:'n', page }) });
  const { pageKey: pk, inboxPath: ip, tasksPath: tp } = require('../lib/queue.js');
  assert.ok(fs.existsSync(ip(queueDir, pk(page))), 'per-page inbox written');
  fs.writeFileSync(tp(queueDir, pk(page)), JSON.stringify({ version:1, page, file:'/a.html', tickets:[{ id:'t1', status:'todo' }] }));
  const got = await (await fetch(base + '/__ccfb/tickets?page=' + encodeURIComponent(page))).json();
  assert.equal(got.tickets.length, 1);
  await close();
});

test('POST /__ccfb/clean truncates only the target page board+inbox', async () => {
  const { base, queueDir, close } = await start();
  const page = base + '/b.html';
  const { pageKey: pk, inboxPath: ip, tasksPath: tp } = require('../lib/queue.js');
  await fetch(base + '/__ccfb/tickets', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type:'comment', quote:'x', page }) });
  fs.writeFileSync(tp(queueDir, pk(page)), JSON.stringify({ version:1, page, file:'/b.html', tickets:[{ id:'t', status:'done' }] }));
  await fetch(base + '/__ccfb/clean', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ page }) });
  assert.equal(fs.readFileSync(ip(queueDir, pk(page)), 'utf8'), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(tp(queueDir, pk(page)), 'utf8')).tickets, []);
  await close();
});
