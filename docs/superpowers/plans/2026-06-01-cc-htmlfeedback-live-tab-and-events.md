# cc-htmlfeedback v2 — Implementation Plan (all 11 changes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship cc-htmlfeedback v2 — a non-interfering live feedback tab (status-driven visuals, DOM morph instead of reload), multi-file concurrent fixing in one session with per-page boards, an event-driven loop, and widget UX upgrades (non-done counter, collapsible status sections, per-page Clean, in-progress animation, host-hotkey suppression, startup outstanding-check, judge-in-separate-tab).

**Architecture:** One companion `server.js` serves many files (static `--root` or `--proxy`) and injects the widget; each page gets its own queue dir `(.cc-htmlfeedback/pages/<pagekey>/{feedback_inbox.jsonl, feedback_tasks.json})`, with `index.json` mapping keys→pages. The server appends to per-page inboxes and serves page-scoped tickets/SSE; the worker session is the sole writer of each board and fixes independent files concurrently via subagents. The widget applies verified changes on a ticket's `done` transition by morphing the live DOM with Idiomorph (static) or deferring to upstream HMR (proxy) — never reloading.

**Tech Stack:** Node `http` + `node --test`; vanilla-JS widget (single IIFE in `feedback-widget.html`, built by `build.js`); Idiomorph (vendored inline); Chrome via `mcp__claude-in-chrome__*` for browser verification.

**Spec:** `docs/superpowers/specs/2026-06-01-cc-htmlfeedback-live-tab-and-events-design.md`

**Conventions & gotchas**
- `feedback-widget.html` is canonical; after editing run `node build.js` then `node build.js --check` (must pass). The server serves the built `extension/feedback-widget.js`.
- build.js requires exactly ONE `<style>` and ONE `<script>`, and the `<script>` must be one bare IIFE `(function(){…})()`. Add new JS INSIDE that IIFE; never add a second `<script>`.
- `pageKey(pageUrl)` keys off the URL **pathname** (root-relative file), NOT the origin, so boards survive a port change between sessions.
- Widget DOM behavior has no jsdom harness (not adding one — YAGNI); verify it in Chrome with the JS-assertion snippets shown. `node --test` covers `lib/`+server. `node build.js --check` guards source↔artifact sync.
- Commit after each task. User-level skill files (`~/.claude/skills/cc-htmlfeedback/*`) are OUTSIDE this repo — not committed here; verify by reading them back.

---

# Phase 1 — Queue & server plumbing (per-page, mode, clean)

## Task 1: Per-page queue helpers in `lib/queue.js`

**Files:** Modify `lib/queue.js`; Test `test/queue.test.js`.

- [ ] **Step 1: Write failing tests** — add to `test/queue.test.js`:

```js
const { pageKey, inboxPath, tasksPath, indexPath, readTasks, listPageKeys } = require('../lib/queue.js');
const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');

test('pageKey is stable per pathname and ignores origin/port', () => {
  const a = pageKey('http://127.0.0.1:4321/foo/bar.html');
  const b = pageKey('http://127.0.0.1:9999/foo/bar.html');
  assert.equal(a, b);
  assert.notEqual(a, pageKey('http://127.0.0.1:4321/other.html'));
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('per-page paths nest under pages/<key>/', () => {
  const k = pageKey('http://x/p.html');
  assert.ok(inboxPath('/q', k).endsWith(path.join('pages', k, 'feedback_inbox.jsonl')));
  assert.ok(tasksPath('/q', k).endsWith(path.join('pages', k, 'feedback_tasks.json')));
  assert.ok(indexPath('/q').endsWith('index.json'));
});

test('readTasks returns an empty board when missing; listPageKeys scans pages/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfbq-'));
  assert.deepEqual(readTasks(dir, 'deadbeef0000'), { version: 1, page: '', file: '', tickets: [] });
  fs.mkdirSync(path.join(dir, 'pages', 'aaaaaaaaaaaa'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pages', 'bbbbbbbbbbbb'), { recursive: true });
  assert.deepEqual(listPageKeys(dir).sort(), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/queue.test.js` → FAIL (functions not exported).

- [ ] **Step 3: Implement** — replace `lib/queue.js` with:

```js
// Ticket queue helpers — the file-on-disk contract between the Claude session and the browser.
// Per-page, two-file ownership: the SERVER appends to each page's feedback_inbox.jsonl;
// the SESSION is the sole writer of each page's feedback_tasks.json.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const QUEUE_DIR = '.cc-htmlfeedback';

// Key off the URL pathname (root-relative file) so boards survive a port change.
function fileOf(pageUrl){
  try { const u = new URL(pageUrl); let p = decodeURIComponent(u.pathname || '/'); if (p.endsWith('/')) p += 'index.html'; return p; }
  catch { return pageUrl || '/'; }
}
function pageKey(pageUrl){ return crypto.createHash('sha1').update(fileOf(pageUrl)).digest('hex').slice(0, 12); }

function pageDir(dir, key){ return path.join(dir, 'pages', key); }
function inboxPath(dir, key){ return path.join(pageDir(dir, key), 'feedback_inbox.jsonl'); }
function tasksPath(dir, key){ return path.join(pageDir(dir, key), 'feedback_tasks.json'); }
function indexPath(dir){ return path.join(dir, 'index.json'); }

function newTicket(fields){
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    type: fields.type === 'strike' ? 'strike' : 'comment',
    status: 'todo',
    quote: fields.quote || '', context: fields.context || '', section: fields.section || '',
    note: fields.note || '', page: fields.page || '',
    files: [], result: '', createdAt: now, updatedAt: now,
  };
}

function appendTicket(dir, key, ticket){
  fs.mkdirSync(pageDir(dir, key), { recursive: true });
  fs.appendFileSync(inboxPath(dir, key), JSON.stringify(ticket) + '\n');
}

function readTasks(dir, key){
  try { return JSON.parse(fs.readFileSync(tasksPath(dir, key), 'utf8')); }
  catch { return { version: 1, page: '', file: '', tickets: [] }; }
}

function readIndex(dir){
  try { return JSON.parse(fs.readFileSync(indexPath(dir), 'utf8')); } catch { return {}; }
}
function upsertIndex(dir, key, page){
  const idx = readIndex(dir);
  if (!idx[key]) { idx[key] = { page, file: fileOf(page), firstSeen: Date.now() };
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(indexPath(dir), JSON.stringify(idx, null, 2)); }
  return idx[key];
}
function listPageKeys(dir){
  try { return fs.readdirSync(path.join(dir, 'pages')).filter(n => /^[0-9a-f]{12}$/.test(n)); }
  catch { return []; }
}

module.exports = { QUEUE_DIR, fileOf, pageKey, pageDir, inboxPath, tasksPath, indexPath,
  newTicket, appendTicket, readTasks, readIndex, upsertIndex, listPageKeys };
```

- [ ] **Step 4: Run tests** — `node --test test/queue.test.js` → PASS. (Other tests will break until Task 3 — that's expected; this task's file is green.)

- [ ] **Step 5: Commit**

```bash
git add lib/queue.js test/queue.test.js
git commit -m "feat(queue): per-page paths + pageKey + index helpers (drop single-file inbox/state)"
```

## Task 2: `mode` flag in injected `__CCFB`

**Files:** Modify `lib/inject.js`, `server.js` (both `injectWidget(...)` calls); Test `test/inject.test.js`.

- [ ] **Step 1: Failing test** — add to `test/inject.test.js`:

```js
test('injects the serving mode into __CCFB (defaults to static)', () => {
  assert.ok(injectWidget('<body></body>', 'SID').includes('mode:"static"'));
  assert.ok(injectWidget('<body></body>', 'SID', 'proxy').includes('mode:"proxy"'));
});
```

- [ ] **Step 2: Verify failure** — `node --test test/inject.test.js` → FAIL.

- [ ] **Step 3: Implement** `lib/inject.js`:

```js
function injectWidget(html, sessionId, mode = 'static'){
  if (html.includes('/__ccfb/widget.js')) return html; // idempotent
  const tags =
    `<script>window.__CCFB={endpoint:"",sessionId:${JSON.stringify(sessionId)},mode:${JSON.stringify(mode)}};</script>` +
    `<script src="/__ccfb/widget.js"></script>`;
  return html.includes('</body>') ? html.replace('</body>', tags + '</body>') : html + tags;
}
module.exports = { injectWidget };
```

- [ ] **Step 4: Thread mode in `server.js`** — proxy path: `injectWidget(Buffer.concat(chunks).toString('utf8'), sessionId, 'proxy')`; static path: `injectWidget(buf.toString('utf8'), sessionId, 'static')`.

- [ ] **Step 5: Run** — `node --test test/inject.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/inject.js server.js test/inject.test.js
git commit -m "feat: expose serving mode (static|proxy) to the widget via __CCFB.mode"
```

## Task 3: Page-scoped server routing + clean endpoint

**Files:** Modify `server.js`; Test `test/server.test.js`.

- [ ] **Step 1: Failing tests** — add to `test/server.test.js` (follow the file's existing start/stop harness; assume `start()` returns `{base, close}`):

```js
test('POST routes a comment to its page board; GET ?page returns it', async () => {
  const { base, queueDir, close } = await start();           // existing helper
  const page = base + '/a.html';
  await fetch(base + '/__ccfb/tickets', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ type:'comment', quote:'x', note:'n', page }) });
  const { pageKey, inboxPath } = require('../lib/queue.js');
  const fs = require('node:fs');
  assert.ok(fs.existsSync(inboxPath(queueDir, pageKey(page))), 'per-page inbox written');
  // worker writes the board; simulate it, then read via GET ?page
  const { tasksPath } = require('../lib/queue.js');
  fs.writeFileSync(tasksPath(queueDir, pageKey(page)), JSON.stringify({ version:1, page, file:'/a.html', tickets:[{ id:'t1', status:'todo' }] }));
  const got = await (await fetch(base + '/__ccfb/tickets?page=' + encodeURIComponent(page))).json();
  assert.equal(got.tickets.length, 1);
  await close();
});

test('POST /__ccfb/clean truncates only the target page board+inbox', async () => {
  const { base, queueDir, close } = await start();
  const page = base + '/b.html';
  const { pageKey, inboxPath, tasksPath } = require('../lib/queue.js'); const fs = require('node:fs');
  await fetch(base + '/__ccfb/tickets', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type:'comment', quote:'x', page }) });
  fs.writeFileSync(tasksPath(queueDir, pageKey(page)), JSON.stringify({ version:1, page, file:'/b.html', tickets:[{ id:'t', status:'done' }] }));
  await fetch(base + '/__ccfb/clean', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ page }) });
  assert.equal(fs.readFileSync(inboxPath(queueDir, pageKey(page)), 'utf8'), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(tasksPath(queueDir, pageKey(page)), 'utf8')).tickets, []);
  await close();
});
```

(If the existing `start()` helper doesn't expose `queueDir`, extend it to return the queueDir it created.)

- [ ] **Step 2: Verify failure** — `node --test test/server.test.js` → FAIL.

- [ ] **Step 3: Implement** — update `server.js`:

Update the import:
```js
const { QUEUE_DIR, pageKey, inboxPath, tasksPath, readTasks, upsertIndex, newTicket } = require('./lib/queue.js');
```

Replace the POST `/__ccfb/tickets` handler body:
```js
      req.on('end', () => {
        let fields; try { fields = JSON.parse(body); } catch { return sendJSON(res, 400, { error:'bad json' }); }
        const ticket = newTicket(fields);
        const key = pageKey(fields.page || '');
        fs.mkdirSync(require('path').dirname(inboxPath(queueDir, key)), { recursive: true });
        upsertIndex(queueDir, key, fields.page || '');
        fs.appendFileSync(inboxPath(queueDir, key), JSON.stringify(ticket) + '\n');
        sendJSON(res, 200, ticket);
      });
```

Replace the GET `/__ccfb/tickets` handler to be page-scoped:
```js
    if (p === '/__ccfb/tickets' && req.method === 'GET') {
      const key = pageKey(url.searchParams.get('page') || '');
      return sendJSON(res, 200, readTasks(queueDir, key));
    }
```

Add the clean endpoint (before the SSE block):
```js
    if (p === '/__ccfb/clean' && req.method === 'POST') {
      let body = ''; req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let f; try { f = JSON.parse(body); } catch { return sendJSON(res, 400, { error:'bad json' }); }
        const key = pageKey(f.page || ''); const path = require('node:path');
        try { fs.mkdirSync(path.dirname(tasksPath(queueDir, key)), { recursive: true });
          fs.writeFileSync(inboxPath(queueDir, key), '');
          fs.writeFileSync(tasksPath(queueDir, key), JSON.stringify({ version:1, page: f.page || '', file:'', tickets:[] })); } catch {}
        broadcastTo(key, 'tickets', readTasks(queueDir, key));
        sendJSON(res, 200, { ok: true });
      });
      return;
    }
```

Make SSE page-scoped — replace the events handler and the `sseClients`/`broadcast` plumbing:
```js
  const sseClients = new Set();                      // each: { res, key }
  function broadcastTo(key, event, data){
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) if (c.key === key) { try { c.res.write(payload); } catch {} }
  }
  function broadcastAll(event, data){
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) { try { c.res.write(payload); } catch {} }
  }
```
```js
    if (p === '/__ccfb/events') {
      const key = pageKey(url.searchParams.get('page') || '');
      res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      res.write('retry: 2000\n\n');
      const client = { res, key }; sseClients.add(client);
      req.on('close', () => sseClients.delete(client));
      return;
    }
```

Update `watchState()` to watch the tree and route board changes to the right page:
```js
  function watchState(){
    try { watchers.push(fs.watch(queueDir, { recursive: true }, (_e, f) => {
      if (!f) return; const parts = f.split(path.sep);
      if (parts[parts.length - 1] !== 'feedback_tasks.json') return;
      const key = parts[parts.length - 2];
      try { broadcastTo(key, 'tickets', readTasks(queueDir, key)); } catch {}
    })); } catch {}
  }
```
Update `watchSource()`'s reload broadcast to `broadcastAll('reload', …)` (the widget ignores it; kept for compatibility). Update the `handle` to expose `broadcast: broadcastAll`.

- [ ] **Step 4: Run all tests** — `node --test` → PASS (queue, inject, server, watch-inbox green).

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat(server): page-scoped tickets/SSE routing + per-page clean endpoint"
```

## Task 4: `watch-inbox.js` watches the whole queue tree

**Files:** Modify `lib/watch-inbox.js`; Test `test/watch-inbox.test.js`.

- [ ] **Step 1: Failing test** — add to `test/watch-inbox.test.js`:

```js
test('wakes (exits) when ANY page inbox changes anywhere in the tree', async () => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfbw-'));
  fs.mkdirSync(path.join(dir, 'pages', 'aaaaaaaaaaaa'), { recursive: true });
  const proc = spawn('node', [path.join(__dirname, '..', 'lib', 'watch-inbox.js'), dir, '5000']);
  let out = ''; proc.stdout.on('data', d => out += d);
  await new Promise(r => setTimeout(r, 150));
  fs.appendFileSync(path.join(dir, 'pages', 'aaaaaaaaaaaa', 'feedback_inbox.jsonl'), '{"id":"x"}\n');
  const code = await new Promise(r => proc.on('exit', r));
  assert.equal(code, 0);
  assert.match(out, /aaaaaaaaaaaa/);   // prints the changed page key/path
});
```

- [ ] **Step 2: Verify failure** — `node --test test/watch-inbox.test.js` → FAIL (old signature watches one file).

- [ ] **Step 3: Implement** — replace `lib/watch-inbox.js`:

```js
#!/usr/bin/env node
// Block until ANY feedback_inbox.jsonl under <queueDir> changes (a new comment arrived on
// some page), print the changed relative path, and exit 0. On timeout, print nothing, exit 0.
// Lets the Claude session wait event-driven across all pages, then re-scan per-page boards.
//   node lib/watch-inbox.js <queueDir> [timeoutMs]
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2] || '.cc-htmlfeedback';
const timeoutMs = Number(process.argv[3] || 1800000);

let done = false, timer = null; const watchers = [];
function finish(changed){ if (done) return; done = true;
  if (changed) process.stdout.write(changed + '\n');
  for (const w of watchers) { try { w.close(); } catch {} } clearTimeout(timer); process.exit(0);
}
function isInbox(f){ return f && f.split(path.sep).pop() === 'feedback_inbox.jsonl'; }

try { fs.mkdirSync(dir, { recursive: true }); } catch {}
try {
  // Recursive watch (macOS/Windows). Linux fallback: watch dir + each page subdir.
  watchers.push(fs.watch(dir, { recursive: true }, (_e, f) => { if (isInbox(f)) finish(f); }));
} catch {
  const pages = path.join(dir, 'pages');
  try { for (const k of fs.readdirSync(pages)) watchers.push(fs.watch(path.join(pages, k), (_e, f) => { if (isInbox(f)) finish(path.join('pages', k, f)); })); } catch {}
  try { watchers.push(fs.watch(dir, () => {})); } catch {}
}
timer = setTimeout(() => finish(null), timeoutMs);
```

- [ ] **Step 4: Run** — `node --test test/watch-inbox.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/watch-inbox.js test/watch-inbox.test.js
git commit -m "feat(watch): wake on any page inbox change across the queue tree"
```

---

# Phase 2 — Widget (browser-verified)

> For Tasks 5–11, after each edit run `node build.js && node build.js --check`, then verify in Chrome: `node server.js --root . --port 4321` (background), new tab → `http://127.0.0.1:4321/test.html`, and run the given assertion via `mcp__claude-in-chrome__javascript_tool`. The injected `__CCFB` puts the widget in connected mode. Commit the `.html` + all rebuilt artifacts together.

## Task 5: Counter counts only non-done tickets

**Files:** Modify `feedback-widget.html` (`render()`).

- [ ] **Step 1: Edit `render()`** — replace its trailing four lines:

```js
    countEl.textContent = vis.length;
    badgeEl.textContent = vis.length;
    launch.classList.toggle('has', vis.length > 0);
    empty.style.display = vis.length ? 'none' : 'block';
```
with:
```js
    const outstanding = CCFB ? vis.filter(f => statusOf(f) !== 'done').length : vis.length;
    countEl.textContent = outstanding;
    badgeEl.textContent = outstanding;
    launch.classList.toggle('has', outstanding > 0);
    empty.style.display = vis.length ? 'none' : 'block';   // list still shows done as history
```

- [ ] **Step 2: Build + check** — `node build.js && node build.js --check` → in sync.
- [ ] **Step 3: Browser-verify** — POST a ticket for `…/test.html`, confirm badge `1`; write its page board with that ticket `status:"done"`; confirm `document.querySelector('#fb-launch .fb-badge').textContent === '0'`.
- [ ] **Step 4: Commit** — `git add feedback-widget.html extension/ dist/ && git commit -m "feat(widget): counter counts only non-done tickets"`

## Task 6: Page-scoped client endpoints

**Files:** Modify `feedback-widget.html` (`ccfbBase()` callers: `loadTickets`, `subscribeSSE`, `ccfbPost` stays; add page param).

- [ ] **Step 1: Edit** — make GET tickets + SSE page-scoped:
```js
  function pageParam(){ return 'page=' + encodeURIComponent(location.href); }
  function loadTickets(){ fetch(ccfbBase() + '/__ccfb/tickets?' + pageParam()).then(r => r.json()).then(d => reconcile(d.tickets || [])).catch(() => {}); }
```
and in `subscribeSSE()`:
```js
      const es = new EventSource(ccfbBase() + '/__ccfb/events?' + pageParam());
```
- [ ] **Step 2: Build + check.**
- [ ] **Step 3: Browser-verify** — two tabs on two files; a ticket POSTed for file A appears only in tab A's panel.
- [ ] **Step 4: Commit** — `…-m "feat(widget): page-scoped tickets + SSE subscription"`

## Task 7: Vendor Idiomorph inline

**Files:** Modify `feedback-widget.html` (top of IIFE body).

- [ ] **Step 1: Fetch** — `curl -s https://unpkg.com/idiomorph@0.7.3/dist/idiomorph.min.js -o /tmp/idiomorph.min.js && wc -c /tmp/idiomorph.min.js` (expect ~12–16 KB; pin the exact resolved version in a comment).
- [ ] **Step 2: Inline** — immediately after `(function(){` in the source `<script>`, paste a comment line then the verbatim contents of `/tmp/idiomorph.min.js` (UMD; sets `window.Idiomorph`). Do not reformat. Reference it as `window.Idiomorph`.
- [ ] **Step 3: Build + check** — must still pass (code added inside the existing IIFE; still one `<script>`).
- [ ] **Step 4: Browser-verify** — `({ hasMorph: typeof window.Idiomorph?.morph === 'function' })` → true.
- [ ] **Step 5: Commit** — `…-m "feat(widget): vendor Idiomorph inline for on-done morphing"`

## Task 8: Apply on `done` via morph (static) / defer (proxy); remove reload

**Files:** Modify `feedback-widget.html` (`subscribeSSE`, `reconcile`, `hidePop`, add helpers).

- [ ] **Step 1: No reload on file change** — in `subscribeSSE()` replace `es.addEventListener('reload', () => location.reload());` with `es.addEventListener('reload', () => {});`
- [ ] **Step 2: Detect done transition** — in `reconcile()` track previous status and set a flag, calling `scheduleApply()` after `render()` when any ticket entered `done`:
```js
      const was = f.status; f.status = t.status; f.result = t.result || ''; f.files = t.files || [];
      if (t.status === 'done' && was && was !== 'done') enteredDone = true;
```
(declare `let enteredDone = false;` at top of `reconcile`; after `render();` add `if (enteredDone) scheduleApply();`).
- [ ] **Step 3: Add helpers** (inside the IIFE near reconcile):
```js
  let pendingApply = false;
  function isWidgetEl(n){ return n && n.nodeType === 1 && (['fb-launch','fb-panel','fb-toast','fb-popover'].includes(n.id) || (n.closest && n.closest('#fb-launch,#fb-panel,#fb-toast,#fb-popover'))); }
  function isComposing(){ const ae = document.activeElement; if (ae === ta && pop.style.display === 'block') return true; if (ae && ae.closest && ae.closest('.fb-note')) return true; if (ta && ta.value && ta.value.trim()) return true; return false; }
  function scheduleApply(){ if (!CCFB || CCFB.mode === 'proxy') return; if (isComposing()) { pendingApply = true; return; } applyMorph(); }
  function unwrapAllMarks(){ CONTENT.querySelectorAll('.fb-mark, .fb-pending').forEach(sp => { if (sp.closest('#fb-launch,#fb-panel,#fb-toast,#fb-popover')) return; const p = sp.parentNode; if (!p) return; while (sp.firstChild) p.insertBefore(sp.firstChild, sp); p.removeChild(sp); p.normalize(); }); }
  function applyMorph(){ fetch(location.href, { cache:'no-store' }).then(r => r.text()).then(html => {
      const doc = new DOMParser().parseFromString(html, 'text/html'); unwrapAllMarks();
      window.Idiomorph.morph(document.body, doc.body.innerHTML, { morphStyle:'innerHTML', restoreFocus:true, ignoreActiveValue:true,
        callbacks: { beforeNodeRemoved(n){ if (isWidgetEl(n)) return false; }, beforeNodeMorphed(n){ if (isWidgetEl(n)) return false; } } });
      Object.values(store).forEach(f => { if (!f.removed && statusOf(f) !== 'done' && f.quote && f.page === location.href) reanchor(f); });
      render();
    }).catch(err => console.warn('cc-htmlfeedback: morph failed, leaving page unchanged', err)); }
```
- [ ] **Step 4: Flush deferred apply** — `hidePop()` → append `if (pendingApply){ pendingApply = false; applyMorph(); }`; add `list.addEventListener('focusout', e => { if (e.target.closest && e.target.closest('.fb-note') && pendingApply && !isComposing()){ pendingApply = false; applyMorph(); } });`
- [ ] **Step 5: Build + check + `node --test`.**
- [ ] **Step 6: Browser-verify (static)** — set `window.__savedScrollY=scrollY`; POST a strike for a visible word; edit `test.html` on disk to remove it + write the page board with that ticket `done`; assert `{ textGone:true, widgetAlive:true, scrollPreserved:true }` and no navigation.
- [ ] **Step 7: Browser-verify (proxy)** — run `node server.js --proxy http://127.0.0.1:5599 --port 4321` (5599 = a second static server); confirm `window.__CCFB.mode==='proxy'` and that a `done` does NOT mutate page content via the widget.
- [ ] **Step 8: Commit** — `…-m "feat(widget): morph on done (static) / defer to HMR (proxy); remove reload"`

## Task 9: Collapsible status sections (Done collapsed)

**Files:** Modify `feedback-widget.html` (CSS, markup container, `render()`).

- [ ] **Step 1: CSS** — add to the `<style>` block:
```css
.fb-sec{margin-bottom:6px}
.fb-sec>summary{list-style:none;cursor:pointer;font:700 11px/1.4 -apple-system,sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#5b6072;padding:6px 4px;display:flex;justify-content:space-between}
.fb-sec>summary::-webkit-details-marker{display:none}
.fb-sec .fb-sec-count{color:#9aa1b4}
```
- [ ] **Step 2: render() grouping** — when `CCFB`, render four `<details class="fb-sec" data-st="in-progress|todo|error|done">` sections (a `<summary>` with label + count, then the matching cards), in that order; `done` gets no `open` attribute, the rest get `open`. Preserve a section's open/closed state across re-renders by reading the existing `<details open>` before rebuild and reapplying. Hide empty sections (`hidden`). In disconnected mode keep the current flat list.
```js
  // sketch inside render(): group vis by statusOf, build/reuse a <details> per status.
  // For each section key in ['in-progress','todo','error','done']:
  //   let sec = list.querySelector(':scope > details[data-st="'+key+'"]') or create it
  //     (create with `open` unless key==='done'); set summary text = LABEL[key] + count;
  //   sec.hidden = items.length === 0; move matching cards into sec (after its summary).
```
- [ ] **Step 3: Build + check.**
- [ ] **Step 4: Browser-verify** — with tickets in several statuses: Done section is collapsed; others expanded; toggling Done then triggering a re-render keeps it as the user left it.
- [ ] **Step 5: Commit** — `…-m "feat(widget): collapsible status sections, Done collapsed by default"`

## Task 10: Clean button (this page)

**Files:** Modify `feedback-widget.html` (header button + inline-confirm + handler).

- [ ] **Step 1: Markup** — add a `Clean` button to the panel header (`.fb-headbtns`), e.g. `<button id="fb-clean" type="button" title="Clear all tasks for this page">Clean</button>`.
- [ ] **Step 2: Handler** — inline two-step confirm (no native `confirm()`): first click swaps the label to `Sure?`; second click within 3s clears. On confirm:
```js
  document.getElementById('fb-clean').addEventListener('click', function(){
    const b = this;
    if (b.dataset.armed !== '1'){ b.dataset.armed = '1'; b.textContent = 'Sure?'; setTimeout(() => { b.dataset.armed=''; b.textContent='Clean'; }, 3000); return; }
    b.dataset.armed=''; b.textContent='Clean';
    if (CCFB) fetch(ccfbBase() + '/__ccfb/clean', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ page: location.href }) }).catch(()=>{});
    Object.keys(store).forEach(id => { unwrap(id); delete store[id]; });
    document.querySelectorAll('.fb-mark').forEach(m => { if(!m.closest('#fb-panel,#fb-popover,#fb-launch,#fb-toast')){ const p=m.parentNode; while(m.firstChild)p.insertBefore(m.firstChild,m); p.removeChild(m); p.normalize(); } });
    render();
  });
```
- [ ] **Step 3: Build + check + `node --test`** (server clean endpoint already covered in Task 3).
- [ ] **Step 4: Browser-verify** — two pages with tickets; Clean on page A empties A's board (inbox+tasks truncated, marks gone, badge 0); page B untouched.
- [ ] **Step 5: Commit** — `…-m "feat(widget): per-page Clean button (confirm-guarded)"`

## Task 11: Suppress host hotkeys while composing + in-progress "working" animation

**Files:** Modify `feedback-widget.html` (key handlers + CSS + per-status mark update).

- [ ] **Step 1: Hotkey suppression** — stop key events leaving the widget containers:
```js
  ['keydown','keyup','keypress'].forEach(ev => { pop.addEventListener(ev, e => e.stopPropagation()); panel.addEventListener(ev, e => e.stopPropagation()); });
```
(target-phase widget handlers on `ta` still run first; `preventDefault` is not used, so typing is unaffected. Caveat: capture-phase host listeners aren't blocked — documented.)
- [ ] **Step 2: Working animation CSS** — add to `<style>`:
```css
.fb-mark.fb-working{animation:fbpulse 1.1s ease-in-out infinite}
@keyframes fbpulse{0%,100%{background-color:#fff3bf}50%{background-color:#ffe066}}
.fb-mark.strike.fb-working{animation:fbpulsestrike 1.1s ease-in-out infinite}
@keyframes fbpulsestrike{0%,100%{background-color:#fdeceb}50%{background-color:#f7c8c2}}
@media (prefers-reduced-motion:reduce){.fb-mark.fb-working,.fb-mark.strike.fb-working{animation:none;background-color:#ffe066}}
```
- [ ] **Step 3: Toggle the class per status** — where marks are styled per status (in `render()`/`applyStatus`/the mark className assignment), set `.fb-working` on the content mark spans for a ticket iff `statusOf(f) === 'in-progress'`:
```js
  function syncMarkState(f){ document.querySelectorAll('.fb-mark[data-fb-id="'+f.id+'"]').forEach(m => m.classList.toggle('fb-working', statusOf(f) === 'in-progress')); }
```
Call `syncMarkState(f)` for each ticket inside `render()` (and from `reanchor()` after re-wrapping). 
- [ ] **Step 4: Build + check.**
- [ ] **Step 5: Browser-verify** — set a ticket `in-progress` (write its board) → its on-page mark pulses; move it to `done`/`todo` → pulse stops. With reduced-motion emulation, it's a static tint. Typing `f`/arrows in the open composer does NOT trigger host shortcuts (test on a page with a document `keydown` listener).
- [ ] **Step 6: Commit** — `…-m "feat(widget): suppress host hotkeys while composing + in-progress working animation"`

---

# Phase 3 — Skill (user-level docs; not committed in this repo)

> Edit `~/.claude/skills/cc-htmlfeedback/SKILL.md` and `judge-prompt.md`. Verify by reading back with `grep`. Reflect the new per-page filenames (`feedback_tasks.json`, `feedback_inbox.jsonl`), tree layout, and `node $TOOLING/...` absolute paths.

## Task 12: Judge validates in a separate tab

- [ ] **Step 1:** In `SKILL.md` "Judge" step add a bullet requiring `mcp__claude-in-chrome__tabs_create_mcp` for a NEW tab; never reuse the user's tab. In `judge-prompt.md` step 1, require opening a new dedicated tab.
- [ ] **Step 2:** `grep -n tabs_create_mcp ~/.claude/skills/cc-htmlfeedback/SKILL.md ~/.claude/skills/cc-htmlfeedback/judge-prompt.md` → match in each.

## Task 13: Event-driven background watcher

- [ ] **Step 1:** Replace the drain "Pick"/wait step with the background watcher: `node $TOOLING/lib/watch-inbox.js <QUEUE> 1800000` run with `run_in_background: true`; harness re-invokes on exit; re-scan all pages, merge, re-arm. (Note watch-inbox's new 2-arg signature: `<queueDir> [timeoutMs]`.)
- [ ] **Step 2:** `grep -n "run_in_background\|watch-inbox.js <QUEUE> 1800000" ~/.claude/skills/cc-htmlfeedback/SKILL.md` → match.

## Task 14: Startup outstanding-feedback check

- [ ] **Step 1:** Add to the "Start" sequence: scan `index.json` + each page's `feedback_tasks.json`; if any non-`done` tickets, summarize grouped by page+status and ask the user: resume / explain-errors (show `result`) / clean. Then drain.
- [ ] **Step 2:** `grep -n "outstanding\|resume\|explain" ~/.claude/skills/cc-htmlfeedback/SKILL.md` → match.

## Task 15: Multi-file concurrent drain (parallel subagents, per-page boards)

- [ ] **Step 1:** Rewrite the "Drain loop" for multi-file: collect `todo` tickets across all pages (`listPageKeys`); dispatch **independent** tickets (distinct files) to parallel `Agent` subagents (cap ≤ 4), each doing locate→edit→(tab morphs on done)→judge-in-separate-tab→write THAT page's `feedback_tasks.json`; serialize tickets on the same file. Note per-page boards make concurrent writes race-free. Update all `state.json`→`feedback_tasks.json` and inbox references.
- [ ] **Step 2:** `grep -n "feedback_tasks.json\|parallel\|subagent" ~/.claude/skills/cc-htmlfeedback/SKILL.md` → match; `grep -n "state.json\|inbox.jsonl" ~/.claude/skills/cc-htmlfeedback/SKILL.md` → NO match (old names fully replaced).

---

# Phase 4 — Integration

## Task 16: Full end-to-end verification (Chrome)

- [ ] **Step 1:** Run the spec's 11-step E2E verification (multi-file, immediate marks, concurrent fixes, separate judge tab, morph-no-reload, in-progress animation, badge→0, collapsible Done, per-page Clean, event-driven idle, compose-defer, startup check, proxy defer).
- [ ] **Step 2:** Clean up — `pkill -f "server.js .*--port 4321"`; restore any throwaway edits to `test.html`/`.cc-htmlfeedback` with `git checkout`/`trash` (never `rm`).
- [ ] **Step 3:** Final commit if verification drove fixes — `git add -A && git commit -m "test: v2 end-to-end verification"`.

---

## Self-review

- **Spec coverage:** Change 1→T5; 2→T7+T8 (+mode T2); 3→T12; 4→T4+T13; 5→T14; 6→T1+T3+T4+T6+T15; 7→T1+T3; 8→T9; 9→T3+T10; 10→T11; 11→T11. Verification→T16.
- **Name consistency:** `pageKey/inboxPath/tasksPath/indexPath/readTasks/listPageKeys/upsertIndex` defined in T1 and used in T3/T4/T15; `__CCFB.mode` produced T2, consumed T8; `applyMorph/scheduleApply/pendingApply/isComposing/isWidgetEl/unwrapAllMarks/syncMarkState` defined+used within T8/T11; `broadcastTo/broadcastAll` defined+used in T3; client `pageParam()` T6 used by T6/T8 fetches.
- **Placeholder scan:** the only non-literal is the vendored Idiomorph paste (T7 Step 2) — an external artifact fetched at execution time with an exact URL+version; the render()-grouping in T9 Step 2 is given as a precise sketch with exact element/attribute names (acceptable: it's DOM-assembly glue, fully specified by the surrounding steps). Everything else is literal code.
