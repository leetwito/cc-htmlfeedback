# cc-htmlfeedback Connected Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn cc-htmlfeedback into a live work queue — a comment in the browser becomes a ticket that the same Claude Code session drains (fix → hot reload → judge → done), with the sidebar as a persistent todo/in-progress/done board. Standalone copy-paste mode stays.

**Architecture:** A small dependency-free Node companion server (`server.js`) serves/injects the widget, exposes REST + SSE, and watches files. A JSON-on-disk queue (`.cc-htmlfeedback/inbox.jsonl` server-writes, `state.json` session-writes) is the contract between the Claude session and the browser — the session never speaks HTTP. The `/cc-htmlfeedback` skill runs the loop in-session and spawns a judge agent per ticket.

**Tech Stack:** Node ≥18 standard library only (`node:http`, `node:fs`, `node:test`); the existing dependency-free widget (`feedback-widget.html` → `build.js`); Claude Code skill + `mcp__claude-in-chrome__*` for the loop and judge.

**Reference spec:** `docs/superpowers/specs/2026-05-24-cc-htmlfeedback-claude-loop-design.md`

---

## File structure

**New:**
- `server.js` — companion server: CLI, HTTP routing, static/proxy serving, widget injection, REST, SSE, file watching. (Root-level, sibling of `build.js`.)
- `lib/queue.js` — pure helpers: append to inbox, read/write state, ticket shape/validation. Imported by `server.js` (server side) — the session reads/writes the files directly, not via this module.
- `lib/inject.js` — pure function: insert the widget `<script>` tags before `</body>` in an HTML string.
- `test/queue.test.js`, `test/inject.test.js`, `test/server.test.js` — `node:test` suites.
- `.claude/skills/cc-htmlfeedback/SKILL.md` — the `/cc-htmlfeedback` loop skill (start/stop, drain, judge dispatch).
- `.claude/skills/cc-htmlfeedback/judge-prompt.md` — the judge agent prompt template.
- `.cc-htmlfeedback/` — runtime queue dir (gitignored; created at runtime).

**Modified:**
- `feedback-widget.html` — add transport seam (standalone vs connected), SSE subscription, status board (pills + grouping + page labels), re-anchoring, standalone upsell banner. Then `node build.js`.
- `package.json` — add `"test": "node --test"`, `"serve": "node server.js"`.
- `.gitignore` — add `.cc-htmlfeedback/`.
- `README.md` — document connected mode + `/cc-htmlfeedback`.

**Phases (each independently testable):**
1. Server foundation (queue + inject + static serve + REST + SSE + watch).
2. Widget connected mode (transport, board UI, SSE, re-anchor, banner).
3. The `/cc-htmlfeedback` skill + judge agent (the loop).
4. Proxy mode + polish (page labels, cross-session persistence, "what changed").

---

## Phase 1 — Server foundation

### Task 1.1: Ticket queue helpers (`lib/queue.js`)

**Files:**
- Create: `lib/queue.js`
- Test: `test/queue.test.js`

- [ ] **Step 1: Write failing tests**

```js
// test/queue.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendTicket, readState, newTicket } = require('../lib/queue.js');

function tmpDir(){ return fs.mkdtempSync(path.join(os.tmpdir(), 'ccfb-')); }

test('newTicket fills id, status=todo, createdAt', () => {
  const t = newTicket({ note: 'make it blue', page: 'http://x/' });
  assert.ok(t.id && typeof t.id === 'string');
  assert.equal(t.status, 'todo');
  assert.ok(t.createdAt > 0);
  assert.equal(t.note, 'make it blue');
});

test('appendTicket writes one JSONL line per call', () => {
  const dir = tmpDir();
  appendTicket(dir, newTicket({ note: 'a', page: 'p' }));
  appendTicket(dir, newTicket({ note: 'b', page: 'p' }));
  const lines = fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).note, 'a');
});

test('readState returns empty tickets when state.json missing', () => {
  assert.deepEqual(readState(tmpDir()), { version: 1, tickets: [] });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/queue.test.js`
Expected: FAIL — `Cannot find module '../lib/queue.js'`.

- [ ] **Step 3: Implement `lib/queue.js`**

```js
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const QUEUE_DIR = '.cc-htmlfeedback';
function inboxPath(dir){ return path.join(dir, 'inbox.jsonl'); }
function statePath(dir){ return path.join(dir, 'state.json'); }

function newTicket(fields){
  return {
    id: crypto.randomUUID(),
    type: fields.type === 'strike' ? 'strike' : 'comment',
    status: 'todo',
    quote: fields.quote || '',
    context: fields.context || '',
    section: fields.section || '',
    note: fields.note || '',
    page: fields.page || '',
    files: [],
    result: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function appendTicket(dir, ticket){
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(inboxPath(dir), JSON.stringify(ticket) + '\n');
}

function readState(dir){
  try { return JSON.parse(fs.readFileSync(statePath(dir), 'utf8')); }
  catch { return { version: 1, tickets: [] }; }
}

module.exports = { QUEUE_DIR, inboxPath, statePath, newTicket, appendTicket, readState };
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/queue.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/queue.js test/queue.test.js && git commit -m "feat(server): ticket queue helpers"
```

### Task 1.2: Widget injection (`lib/inject.js`)

**Files:**
- Create: `lib/inject.js`
- Test: `test/inject.test.js`

- [ ] **Step 1: Write failing tests**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { injectWidget } = require('../lib/inject.js');

test('inserts both script tags before </body>', () => {
  const out = injectWidget('<html><body><h1>hi</h1></body></html>', 'SID');
  assert.ok(out.includes('window.__CCFB'));
  assert.ok(out.includes('/__ccfb/widget.js'));
  assert.ok(out.indexOf('__ccfb/widget.js') < out.indexOf('</body>'));
  assert.ok(out.includes('"SID"'));
});

test('appends at end when no </body>', () => {
  const out = injectWidget('<h1>hi</h1>', 'SID');
  assert.ok(out.includes('/__ccfb/widget.js'));
});

test('does not double-inject', () => {
  const once = injectWidget('<body></body>', 'SID');
  const twice = injectWidget(once, 'SID');
  assert.equal(twice.match(/__ccfb\/widget\.js/g).length, 1);
});
```

- [ ] **Step 2: Run, verify fail** — `node --test test/inject.test.js` → module not found.

- [ ] **Step 3: Implement `lib/inject.js`**

```js
function injectWidget(html, sessionId){
  if (html.includes('/__ccfb/widget.js')) return html; // idempotent
  const tags =
    `<script>window.__CCFB={endpoint:"",sessionId:${JSON.stringify(sessionId)}};</script>` +
    `<script src="/__ccfb/widget.js"></script>`;
  return html.includes('</body>')
    ? html.replace('</body>', tags + '</body>')
    : html + tags;
}
module.exports = { injectWidget };
```

- [ ] **Step 4: Run, verify pass** — 3 tests PASS.

- [ ] **Step 5: Commit** — `git add lib/inject.js test/inject.test.js && git commit -m "feat(server): widget HTML injection"`

### Task 1.3: HTTP server — static serve + inject + REST + SSE + watch (`server.js`)

**Files:**
- Create: `server.js`
- Test: `test/server.test.js`

- [ ] **Step 1: Write failing integration test**

```js
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../server.js');

test('serves root HTML with widget injected, and POST appends a ticket', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfb-root-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html><body>hello</body></html>');
  const queueDir = path.join(root, '.cc-htmlfeedback');
  const srv = startServer({ root, queueDir, port: 0, sessionId: 'SID' });
  const base = `http://127.0.0.1:${srv.port}`;

  const page = await (await fetch(base + '/')).text();
  assert.ok(page.includes('/__ccfb/widget.js'));

  const res = await fetch(base + '/__ccfb/tickets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'make it blue', page: base + '/' }),
  });
  assert.equal(res.status, 200);
  const lines = fs.readFileSync(path.join(queueDir, 'inbox.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).note, 'make it blue');

  srv.close();
});
```

- [ ] **Step 2: Run, verify fail** — `node --test test/server.test.js` → `startServer` not exported.

- [ ] **Step 3: Implement `server.js`** (static mode + REST + SSE + watch; `--proxy` is Task 4.1)

```js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { injectWidget } = require('./lib/inject.js');
const { QUEUE_DIR, inboxPath, statePath, newTicket } = require('./lib/queue.js');

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

function startServer({ root, queueDir, port = 0, sessionId = crypto.randomUUID(), widgetPath } = {}) {
  fs.mkdirSync(queueDir, { recursive: true });
  widgetPath = widgetPath || path.join(__dirname, 'extension', 'feedback-widget.js');
  const sseClients = new Set();

  function broadcast(event, data){
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
  }
  function sendJSON(res, code, obj){ res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj)); }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/__ccfb/widget.js') {
      res.writeHead(200, {'content-type':'text/javascript'});
      return res.end(fs.readFileSync(widgetPath));
    }
    if (p === '/__ccfb/tickets' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let fields; try { fields = JSON.parse(body); } catch { return sendJSON(res, 400, {error:'bad json'}); }
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
    // static file serving with HTML injection
    let filePath = path.join(root, decodeURIComponent(p));
    if (p.endsWith('/')) filePath = path.join(filePath, 'index.html');
    if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(filePath, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(filePath);
      if (ext === '.html') {
        res.writeHead(200, {'content-type':'text/html'});
        return res.end(injectWidget(buf.toString('utf8'), sessionId));
      }
      res.writeHead(200, {'content-type': MIME[ext] || 'application/octet-stream'});
      res.end(buf);
    });
  });

  // file watchers: state.json -> tickets event; source tree -> reload event (debounced)
  let reloadTimer = null;
  function watchState(){
    try { fs.watch(queueDir, (_e, f) => { if (f === 'state.json') {
      try { broadcast('tickets', JSON.parse(fs.readFileSync(statePath(queueDir),'utf8'))); } catch {}
    }}); } catch {}
  }
  function watchSource(){
    try { fs.watch(root, { recursive: true }, (_e, f) => {
      if (f && f.includes(QUEUE_DIR)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => broadcast('reload', { at: Date.now() }), 150);
    }); } catch {}
  }

  server.listen(port, '127.0.0.1', () => { watchState(); watchSource(); });
  const handle = {
    get port(){ return server.address().port; },
    sessionId, broadcast,
    close(){ for (const r of sseClients) r.end(); server.close(); },
  };
  return handle;
}

if (require.main === module) {
  const args = require('node:util').parseArgs({ options: {
    root: { type:'string', default:'.' }, port: { type:'string', default:'4317' },
  }}).values;
  const root = path.resolve(args.root);
  const queueDir = path.join(root, QUEUE_DIR);
  const h = startServer({ root, queueDir, port: Number(args.port) });
  console.log(`cc-htmlfeedback server on http://127.0.0.1:${h.port} (root: ${root})`);
}

module.exports = { startServer };
```

- [ ] **Step 4: Run, verify pass** — `node --test test/server.test.js` → PASS.

- [ ] **Step 5: Run full suite + manual SSE check**

Run: `node --test`
Then manual: `node server.js --root test-fixtures --port 4317 &` then `curl -N http://127.0.0.1:4317/__ccfb/events &` and in another shell append a state.json change; confirm the curl prints a `tickets` event. Kill both.
Expected: all node tests PASS; SSE prints the event.

- [ ] **Step 6: Commit** — `git add server.js test/server.test.js package.json && git commit -m "feat(server): static serve + inject + REST + SSE + file watch"`

### Task 1.4: package.json scripts + .gitignore

**Files:** Modify `package.json`, `.gitignore`

- [ ] **Step 1: Add scripts** to `package.json`: `"test": "node --test"`, `"serve": "node server.js"`.
- [ ] **Step 2: Add to `.gitignore`:** a line `.cc-htmlfeedback/`.
- [ ] **Step 3: Run** `npm test` → all PASS.
- [ ] **Step 4: Commit** — `git add package.json .gitignore && git commit -m "chore: test/serve scripts; gitignore runtime queue"`

---

## Phase 2 — Widget connected mode

All edits are in `feedback-widget.html` (canonical); after each, run `node build.js` and verify in Chrome by injecting `extension/feedback-widget.js` into a served page (the existing browser harness). There is no JS unit harness for the widget; verification is end-to-end in Chrome per the project's existing practice.

### Task 2.1: Transport seam — connected submit

**Files:** Modify `feedback-widget.html` (the widget `<script>`)

- [ ] **Step 1: Add a transport detector + submit fork.** Near the top of the IIFE (after `__CCFB` would be set by the server), add:

```js
var CCFB = window.__CCFB || null;            // present only in connected mode
function ccfbPost(ticket){
  return fetch((CCFB.endpoint||'') + '/__ccfb/tickets', {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(ticket)
  });
}
```

- [ ] **Step 2: Fork `add(type)`** so that in connected mode it also POSTs the ticket. In `add()`, after building the stored object `store[id]`, add:

```js
if (CCFB) ccfbPost({ type, quote: store[id].quote, context: store[id].context,
  section: store[id].section, note: store[id].note, page: location.href }).catch(()=>{});
```

(The optimistic local card already renders as the existing in-memory note; connected status will overwrite it in Task 2.3.)

- [ ] **Step 3: Build + verify** — `node build.js`; serve `test.html` via `node server.js --root .`, open in Chrome, submit a comment, confirm a line lands in `.cc-htmlfeedback/inbox.jsonl` (read the file). 
- [ ] **Step 4: Commit** — `git add feedback-widget.html extension/ dist/ && git commit -m "feat(widget): POST tickets in connected mode"`

### Task 2.2: Status model on cards

**Files:** Modify `feedback-widget.html`

- [ ] **Step 1:** Give each stored item a `status` (default `'todo'` in connected mode, undefined in standalone) and a `pageLabel`. Add a `statusOf(f)` helper returning `f.status || 'todo'`.
- [ ] **Step 2:** Extend `cardHTML(f)` to render a status pill when connected: `<span class="fb-status fb-st-<status>">todo|in progress|done|error</span>`, plus the page label and (for `done`) the `result` line. Add CSS for `.fb-status` variants.
- [ ] **Step 3: Build + verify** — render a fake connected state (set `window.__CCFB`, push items with statuses) and confirm pills show. 
- [ ] **Step 4: Commit.**

### Task 2.3: SSE subscription + reconcile + reload

**Files:** Modify `feedback-widget.html`

- [ ] **Step 1:** In connected mode, after init, open SSE and handle events:

```js
if (CCFB) {
  var es = new EventSource((CCFB.endpoint||'') + '/__ccfb/events');
  es.addEventListener('tickets', function(e){ reconcile(JSON.parse(e.data).tickets); });
  es.addEventListener('reload', function(){ location.reload(); });
}
```

- [ ] **Step 2:** Implement `reconcile(tickets)`: merge server tickets into `store` by `id` (server is authoritative for `status`/`result`/`files`), then `render()`. Match optimistic local cards to server tickets by `(quote,note,page)` until the server assigns the same `id`.
- [ ] **Step 3:** Group the list under `Todo / In-progress / Done` headers in `render()` when connected; sort within group by `createdAt`.
- [ ] **Step 4: Build + verify in Chrome** — run server, submit a comment, then manually edit `.cc-htmlfeedback/state.json` to flip the ticket to `in-progress` then `done`; confirm the card pill updates live via SSE and a touch of a served file triggers reload.
- [ ] **Step 5: Commit.**

### Task 2.4: Re-anchoring on load

**Files:** Modify `feedback-widget.html`

- [ ] **Step 1:** Add `reanchor(ticket)`: if `ticket.page === location.href` and `ticket.quote`, find the first text node whose block (`blockOf`) text contains `ticket.context` (fallback: contains `ticket.quote`), locate `quote` within it, and wrap a `.fb-mark`. On miss, mark the card "anchor lost". Reuse existing `wrap`/`blockOf`.
- [ ] **Step 2:** On connected load, after fetching `GET /__ccfb/tickets`, run `reanchor` for current-page tickets; off-page tickets render in the board without highlights (labeled by page).
- [ ] **Step 3: Build + verify** — submit, let it persist in state.json, reload the page, confirm highlight re-attaches; navigate to a different URL and confirm the ticket still lists (labeled) without a highlight.
- [ ] **Step 4: Commit.**

### Task 2.5: Standalone upsell banner

**Files:** Modify `feedback-widget.html`

- [ ] **Step 1:** When NOT connected, render a dismissible banner in the panel head: text "💡 Want Claude to fix these live? Run `/cc-htmlfeedback` in Claude Code." + a copy button that copies the prompt string `Run /cc-htmlfeedback to start the live feedback loop for this page.` Dismissal stored in `localStorage['ccfb-banner-dismissed']`.
- [ ] **Step 2:** Hide the banner entirely in connected mode.
- [ ] **Step 3: Build + verify** in Chrome (standalone: banner shows, copy works, dismiss persists across reload; connected: hidden).
- [ ] **Step 4: Commit.**

---

## Phase 3 — The `/cc-htmlfeedback` skill + judge agent

### Task 3.1: Judge prompt (`judge-prompt.md`)

**Files:** Create `.claude/skills/cc-htmlfeedback/judge-prompt.md`

- [ ] **Step 1:** Write the judge prompt template (filled per ticket):

```
You are a verification judge. Do NOT edit code. A change was just made to satisfy
this user comment on a web page:

  Page:    {page}
  Element: "{quote}"  (section: {section})
  Asked:   {note}
  Files touched: {files}

Open {page} in Chrome (mcp__claude-in-chrome) and verify:
1. The change requested by "Asked" is actually present/working on the page.
2. The page is not broken (no thrown errors, layout intact, console clean of new errors).

Return ONLY JSON: {"verdict":"pass"|"fail","reason":"<one sentence>","evidence":"<what you observed>"}.
```

- [ ] **Step 2: Commit.**

### Task 3.2: The loop skill (`SKILL.md`)

**Files:** Create `.claude/skills/cc-htmlfeedback/SKILL.md`

- [ ] **Step 1:** Write the skill with frontmatter (`name: cc-htmlfeedback`, description triggering on the slash command) and the procedure:
  - **start:** detect serve mode (existing dev server URL → `--proxy`, else `--root .`); spawn `node server.js …` in background; open the app in Chrome; announce the loop is listening; begin draining.
  - **drain loop:** read new `inbox.jsonl` lines not yet in `state.json`; for each, write `state.json` with the ticket `in-progress`; locate source by grepping `quote` (disambiguate with `section`/`context`/`page`); apply the edit per `note` (full dev task); wait for reload; spawn a judge agent (general-purpose) with `judge-prompt.md` filled in; on `pass` set `done` + `result` + `files`, on `fail` set `error` + reason. Re-read inbox between tickets.
  - **state.json discipline:** the session is the only writer; read-modify-write the whole file.
  - **stop:** kill the server process; end the loop.
- [ ] **Step 2: Verify** the skill loads (`/cc-htmlfeedback` appears) and dry-run the start path on `test.html`.
- [ ] **Step 3: Commit.**

### Task 3.3: End-to-end manual verification (one full cycle)

- [ ] **Step 1:** `/cc-htmlfeedback` on `test.html`; in Chrome, comment "change the H1 to 'Orbit v2'"; observe ticket `todo → in-progress`, the file edit, page reload, judge agent run, ticket `done` with a result. Confirm `state.json` and the card agree.
- [ ] **Step 2:** Submit an impossible request; confirm it lands in `error` with the judge's reason.
- [ ] **Step 3: Commit** any skill fixes found.

---

## Phase 4 — Proxy mode + polish

### Task 4.1: `--proxy <devUrl>` mode

**Files:** Modify `server.js`, `test/server.test.js`

- [ ] **Step 1:** Add a failing test: with `--proxy` pointed at a stub upstream serving `<body>hi</body>`, `GET /` returns the upstream HTML **with the widget injected**; non-HTML passes through untouched.
- [ ] **Step 2:** Implement proxy: when `proxy` is set, forward the request to the upstream with `http.request`; if response `content-type` is `text/html`, buffer + `injectWidget` + resend, else stream through. Keep `/__ccfb/*` handled locally (not proxied).
- [ ] **Step 3:** Run tests → PASS. **Step 4:** Commit.

### Task 4.2: Cross-session persistence + "what changed" summaries

**Files:** the skill (`SKILL.md`), `feedback-widget.html`

- [ ] **Step 1:** Confirm `state.json` is never truncated on start (the loop appends/updates, keeping `done`/`error` history) — board shows full history across restarts.
- [ ] **Step 2:** Ensure each `done` ticket's `result` is a one-line summary and `files` lists touched paths; the card already renders them (Task 2.2).
- [ ] **Step 3: Verify** restart-the-loop keeps prior tickets visible. **Step 4:** Commit.

### Task 4.3: README + docs

**Files:** Modify `README.md`

- [ ] **Step 1:** Add a "Connected mode (live fixes with Claude Code)" section: install, `/cc-htmlfeedback`, the loop, the judge, the standalone banner. **Step 2:** Commit.

---

## Self-review notes

- **Spec coverage:** two modes (Task 2.x + banner 2.5) ✓; companion server REST/SSE/inject/watch (1.3) ✓; two-file queue ownership (1.1, server appends inbox / session writes state) ✓; loop (3.2) ✓; judge agent (3.1, 3.2) ✓; full-task fixes (3.2) ✓; immediate one-at-a-time (3.2 drain) ✓; refine = new comment (no reopen task — correct) ✓; shared persistent page-labeled board (2.2, 2.3, 4.2) ✓; re-anchoring current-page only (2.4) ✓; done=applied+judged (3.2) ✓; root + proxy (1.3, 4.1) ✓; localhost-only bind (1.3) ✓; security: comment-as-task-not-command lives in the skill's edit step (3.2) and judge is read-only (3.1) ✓.
- **Naming consistency:** `startServer({root,queueDir,port,sessionId,widgetPath})`, `injectWidget(html,sessionId)`, `newTicket(fields)`, `appendTicket(dir,ticket)`, `readState(dir)`, endpoints `/__ccfb/tickets|events|widget.js`, `window.__CCFB={endpoint,sessionId}`, SSE events `tickets`/`reload`, statuses `todo|in-progress|done|error` — used consistently across tasks.
- **YAGNI:** no auto-retry, no auth, no multi-user, no kanban drag-drop.
