# cc-htmlfeedback Live-Tab & Event-Driven Loop — Implementation Plan

> **⚠️ STATUS — STALE / PARTIAL (2026-06-01):** This plan was written against the original
> 4-change scope and covers only Changes 1–4 (+ the `__CCFB.mode` flag). The approved spec
> has since grown to **10 changes** (multi-file per-page boards, file rename, startup check,
> collapsible status sections, clean button, host-hotkey suppression). **Regenerate this
> plan from the current spec before executing.** Tasks below remain valid building blocks
> for Changes 1–4 but are incomplete for v2.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the user's live feedback tab non-interfering (status-driven visuals, DOM morph instead of reload), drop the counter to zero when all tickets are done, isolate judge validation to a separate tab, and make the worker loop event-driven.

**Architecture:** Four changes. Two touch node-testable plumbing (`lib/inject.js`, `server.js`) and the browser widget (`feedback-widget.html`, rebuilt via `build.js`); two are doc edits to the user-level skill at `~/.claude/skills/cc-htmlfeedback/`. The widget applies the verified change on a ticket's `done` transition by **morphing** the live DOM (static mode) with [Idiomorph](https://github.com/bigskysoftware/idiomorph), or by deferring to the upstream dev server's HMR (proxy mode). `location.reload()` is removed entirely.

**Tech Stack:** Vanilla JS widget (single IIFE inside `feedback-widget.html`), Node `http` server, `node --test`, Idiomorph (vendored inline), Chrome via `mcp__claude-in-chrome__*` for browser verification.

**Spec:** `docs/superpowers/specs/2026-06-01-cc-htmlfeedback-live-tab-and-events-design.md`

**Testing note:** Widget code runs in the browser and the project has no jsdom harness (YAGNI — not adding one). So widget behavior is verified with the Chrome MCP tools using explicit JS assertion snippets (returning JSON), exactly as the spec's verification section prescribes. Node `--test` covers the `lib/`/server plumbing (Task 1). `node build.js --check` guards source↔artifact sync after every widget edit.

**Build reminder:** `feedback-widget.html` is the canonical source. After editing it, run `node build.js` (regenerates `extension/feedback-widget.js` + `dist/*`) and `node build.js --check` (must pass). The served widget is `extension/feedback-widget.js`. build.js requires exactly ONE `<style>` and ONE `<script>` block, and the `<script>` must be a single bare IIFE `(function(){ ... })()` — do not add a second `<script>`.

---

## Task 1: Thread serving-mode (static|proxy) into the injected `__CCFB` flag

The widget must know whether it is in static mode (it morphs) or proxy mode (it defers to upstream HMR). The server injects `window.__CCFB`; add a `mode` field.

**Files:**
- Modify: `lib/inject.js`
- Modify: `server.js` (the two `injectWidget(...)` call sites: proxy path ~line 42, static path ~line 100)
- Test: `test/inject.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/inject.test.js`:

```js
test('injects the serving mode into __CCFB (defaults to static)', () => {
  const def = injectWidget('<body></body>', 'SID');
  assert.ok(def.includes('mode:"static"'), 'defaults to static');
  const prox = injectWidget('<body></body>', 'SID', 'proxy');
  assert.ok(prox.includes('mode:"proxy"'), 'honors explicit proxy mode');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/inject.test.js`
Expected: FAIL — the new test fails because `mode:"static"` is not in the output yet.

- [ ] **Step 3: Implement the minimal change in `lib/inject.js`**

```js
// Insert the cc-htmlfeedback widget into a served HTML document (connected mode).
function injectWidget(html, sessionId, mode = 'static'){
  if (html.includes('/__ccfb/widget.js')) return html; // idempotent
  const tags =
    `<script>window.__CCFB={endpoint:"",sessionId:${JSON.stringify(sessionId)},mode:${JSON.stringify(mode)}};</script>` +
    `<script src="/__ccfb/widget.js"></script>`;
  return html.includes('</body>')
    ? html.replace('</body>', tags + '</body>')
    : html + tags;
}
module.exports = { injectWidget };
```

- [ ] **Step 4: Pass the mode at both call sites in `server.js`**

Proxy path (inside `proxyRequest`, the line that builds `const html = injectWidget(...)`):

```js
const html = injectWidget(Buffer.concat(chunks).toString('utf8'), sessionId, 'proxy');
```

Static path (the `return res.end(injectWidget(buf.toString('utf8'), sessionId));` line):

```js
return res.end(injectWidget(buf.toString('utf8'), sessionId, 'static'));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/inject.test.js test/server.test.js`
Expected: PASS (all inject + server tests green; existing `out.includes('window.__CCFB')` assertion still holds).

- [ ] **Step 6: Commit**

```bash
git add lib/inject.js server.js test/inject.test.js
git commit -m "feat: expose serving mode (static|proxy) to the widget via __CCFB.mode"
```

---

## Task 2: Counter shows only non-done tickets (badge → 0 when all done)

**Files:**
- Modify: `feedback-widget.html` (`render()`), then rebuild artifacts.

- [ ] **Step 1: Edit `render()` in `feedback-widget.html`**

Replace the four trailing lines of `render()`:

```js
    countEl.textContent = vis.length;
    badgeEl.textContent = vis.length;
    launch.classList.toggle('has', vis.length > 0);
    empty.style.display = vis.length ? 'none' : 'block';
```

with:

```js
    // Badge/count = OUTSTANDING tickets only (done dropped) so all-done → 0.
    // In disconnected mode statusOf() is null, so nothing is excluded (count = all).
    const outstanding = CCFB ? vis.filter(f => statusOf(f) !== 'done').length : vis.length;
    countEl.textContent = outstanding;
    badgeEl.textContent = outstanding;
    launch.classList.toggle('has', outstanding > 0);
    empty.style.display = vis.length ? 'none' : 'block';   // list still shows done as history
```

- [ ] **Step 2: Rebuild and verify artifact sync**

Run: `node build.js && node build.js --check`
Expected: "Built dist/feedback-widget.js …" then "build.js --check: all 4 outputs in sync".

- [ ] **Step 3: Browser-verify the counter (Chrome MCP)**

Start a server: `node server.js --root . --port 4321` (background). Create a NEW tab, navigate to `http://127.0.0.1:4321/test.html`. Then run this assertion via `mcp__claude-in-chrome__javascript_tool` (it drives the widget's own reconcile with a connected-mode stub):

```js
(() => {
  // simulate connected mode if not already: inject two tickets, one done
  const w = window.__fbWidget; // panel api exists; use the SSE reconcile path indirectly
  // Read the live badge after pushing a fake ticket set through the tickets endpoint is overkill;
  // instead assert the rule directly against the rendered badge with known store state:
  const badge = document.querySelector('#fb-launch .fb-badge');
  return { badgeText: badge && badge.textContent };
})()
```

Authoritative check (connected mode): with the server running, POST one ticket then mark it done in `state.json`, confirming the badge decrements to 0. Use the real flow:
1. `curl -s -X POST http://127.0.0.1:4321/__ccfb/tickets -H 'content-type: application/json' -d '{"type":"comment","quote":"Claude","note":"x","page":"http://127.0.0.1:4321/test.html"}'` → badge should become `1` (open the page connected: navigate to `http://127.0.0.1:4321/test.html` — the injected `__CCFB` puts the widget in connected mode and SSE pushes the ticket).
2. Edit `.cc-htmlfeedback/state.json` to set that ticket `"status":"done"` (the server's file watch pushes a `tickets` SSE event).
3. Assert badge text is now `0`:

```js
document.querySelector('#fb-launch .fb-badge').textContent  // expect "0"
```

Expected: badge `1` after POST, `0` after the ticket is `done`.

- [ ] **Step 4: Commit**

```bash
git add feedback-widget.html extension/feedback-widget.js dist/feedback-widget.js dist/feedback-bookmarklet.txt dist/install-bookmarklet.html
git commit -m "feat: counter counts only non-done tickets (badge hits 0 when all done)"
```

---

## Task 3: Vendor Idiomorph inline into the widget IIFE

Idiomorph must live INSIDE the single IIFE body (build.js forbids a second `<script>`). Use the UMD build, which sets `window.Idiomorph`.

**Files:**
- Modify: `feedback-widget.html` (top of the `<script>` IIFE body), then rebuild.

- [ ] **Step 1: Fetch the pinned Idiomorph UMD source**

Run: `curl -s https://unpkg.com/idiomorph@0.7.3/dist/idiomorph.min.js -o /tmp/idiomorph.min.js && wc -c /tmp/idiomorph.min.js`
Expected: a non-empty file (~12–16 KB). (Pin the exact version that resolves; record it in a comment.)

- [ ] **Step 2: Inline it at the very top of the IIFE body**

In `feedback-widget.html`, immediately after the IIFE opens (`(function(){`) and before `'use strict'`/the first widget statement, paste:

```js
  /* vendored: Idiomorph v0.7.3 (https://github.com/bigskysoftware/idiomorph) — DOM morphing for the on-done apply.
     UMD build; sets window.Idiomorph. Do NOT reformat — keep as a single minified line. */
  <<PASTE the exact contents of /tmp/idiomorph.min.js here, verbatim, on the following lines>>
```

The minified UMD references `typeof module`, `window`, etc.; inside our IIFE it attaches to `window.Idiomorph`. Reference it as `window.Idiomorph` everywhere (Task 4). Do not wrap or edit the vendored code.

- [ ] **Step 3: Rebuild and verify artifact sync**

Run: `node build.js && node build.js --check`
Expected: build succeeds; `--check` reports all 4 outputs in sync. (build.js's "single IIFE" assertion still passes because we added code INSIDE the existing IIFE, not a new `<script>`.)

- [ ] **Step 4: Browser-verify Idiomorph loaded**

Serve + open `http://127.0.0.1:4321/test.html` in a new tab, then:

```js
({ hasMorph: typeof window.Idiomorph?.morph === 'function' })
```

Expected: `{ hasMorph: true }`.

- [ ] **Step 5: Commit**

```bash
git add feedback-widget.html extension/feedback-widget.js dist/feedback-widget.js dist/feedback-bookmarklet.txt dist/install-bookmarklet.html
git commit -m "feat: vendor Idiomorph inline into the widget for on-done DOM morphing"
```

---

## Task 4: Apply the change on `done` via morph (static) / defer (proxy); no reload

**Files:**
- Modify: `feedback-widget.html` — `subscribeSSE()`, `reconcile()`, `hidePop()`, and add `applyMorph()` + helpers. Then rebuild.

- [ ] **Step 1: Stop reloading on file-change in `subscribeSSE()`**

Replace:

```js
      es.addEventListener('reload', () => location.reload());
```

with:

```js
      // File-change events no longer touch the user's tab; the page updates only on a
      // ticket's `done` transition (see reconcile → scheduleApply). No full reload, ever.
      es.addEventListener('reload', () => {});
```

- [ ] **Step 2: Detect the `done` transition in `reconcile()` and schedule the apply**

Replace the body of `reconcile()`:

```js
  function reconcile(tickets){
    tickets.forEach(t => {
      let f = Object.values(store).find(x => x.sid === t.id);
      if(!f){
        const id = ++uid;
        f = store[id] = { id, sid: t.id, quote: t.quote || '', context: t.context || '', section: t.section || '',
          note: t.note || '', type: t.type || 'comment', page: t.page || '', removed: false };
        if(t.page === location.href && f.quote) reanchor(f);
      }
      f.status = t.status; f.result = t.result || ''; f.files = t.files || [];
    });
    render();
  }
```

with:

```js
  function reconcile(tickets){
    let enteredDone = false;
    tickets.forEach(t => {
      let f = Object.values(store).find(x => x.sid === t.id);
      if(!f){
        const id = ++uid;
        f = store[id] = { id, sid: t.id, quote: t.quote || '', context: t.context || '', section: t.section || '',
          note: t.note || '', type: t.type || 'comment', page: t.page || '', removed: false };
        if(t.page === location.href && f.quote) reanchor(f);
      }
      const was = f.status;
      f.status = t.status; f.result = t.result || ''; f.files = t.files || [];
      if(t.status === 'done' && was && was !== 'done') enteredDone = true;
    });
    render();
    if(enteredDone) scheduleApply();   // a ticket just finished → reflect the verified change
  }
```

(Note: `was &&` guards the very first reconcile where a ticket is already `done` on load — we don't morph for history that was done before this session.)

- [ ] **Step 3: Add the apply scheduler, morph, and helpers**

Add these functions inside the IIFE, near `reconcile`/`reanchor`:

```js
  /* ---- on-done apply: morph the live DOM (static mode) so the verified change appears
     without a reload, preserving scroll/focus/state. Proxy mode defers to upstream HMR. ---- */
  let pendingApply = false;
  function isWidgetEl(node){
    return node && node.nodeType === 1 &&
      (node.id === 'fb-launch' || node.id === 'fb-panel' || node.id === 'fb-toast' || node.id === 'fb-popover'
       || (node.closest && node.closest('#fb-launch,#fb-panel,#fb-toast,#fb-popover')));
  }
  function isComposing(){
    const ae = document.activeElement;
    if(ae === ta && pop.style.display === 'block') return true;          // selection composer open
    if(ae && ae.closest && ae.closest('.fb-note')) return true;          // editing a card note
    if(ta && ta.value && ta.value.trim()) return true;                   // unsaved draft text
    return false;
  }
  function scheduleApply(){
    if(!CCFB || CCFB.mode === 'proxy') return;   // proxy: the upstream dev server's HMR updates the page
    if(isComposing()){ pendingApply = true; return; }
    applyMorph();
  }
  function unwrapAllMarks(){
    CONTENT.querySelectorAll('.fb-mark, .fb-pending').forEach(sp => {
      if(sp.closest('#fb-launch,#fb-panel,#fb-toast,#fb-popover')) return;
      const p = sp.parentNode; if(!p) return;
      while(sp.firstChild) p.insertBefore(sp.firstChild, sp);
      p.removeChild(sp); p.normalize();
    });
  }
  function applyMorph(){
    fetch(location.href, { cache: 'no-store' })
      .then(r => r.text())
      .then(htmlText => {
        const doc = new DOMParser().parseFromString(htmlText, 'text/html');
        unwrapAllMarks();                          // marks are runtime-only; strip then re-derive
        window.Idiomorph.morph(document.body, doc.body.innerHTML, {
          morphStyle: 'innerHTML',
          restoreFocus: true,
          ignoreActiveValue: true,
          callbacks: {
            beforeNodeRemoved(node){ if(isWidgetEl(node)) return false; },
            beforeNodeMorphed(oldNode){ if(isWidgetEl(oldNode)) return false; }
          }
        });
        Object.values(store).forEach(f => {        // re-anchor marks for still-open tickets
          if(!f.removed && statusOf(f) !== 'done' && f.quote && f.page === location.href) reanchor(f);
        });
        render();
      })
      .catch(err => console.warn('cc-htmlfeedback: morph failed, leaving page unchanged', err));
  }
```

- [ ] **Step 4: Flush a deferred apply when the user stops composing**

In `hidePop()`, append the flush (so closing the selection composer triggers any pending morph):

```js
  function hidePop(){ closePop(); clearPending(); sideManual = false; if(pendingApply){ pendingApply = false; applyMorph(); } }
```

And add a delegated `blur` flush for card-note editing — add near the other `list.addEventListener(...)` handlers:

```js
  list.addEventListener('focusout', e => {
    if(e.target.closest && e.target.closest('.fb-note') && pendingApply && !isComposing()){
      pendingApply = false; applyMorph();
    }
  });
```

- [ ] **Step 5: Rebuild and verify artifact sync + regression**

Run: `node build.js && node build.js --check && node --test`
Expected: build in sync; all node tests pass (lib/server unaffected).

- [ ] **Step 6: Browser-verify the full on-done morph (static mode)**

Serve `node server.js --root . --port 4321`. New tab → `http://127.0.0.1:4321/test.html`. Scroll down, focus an input/area, note `scrollY`. Then drive the real flow:
1. POST a strike ticket whose `quote` is a word visible on the page (e.g. `"Claude"`).
2. Manually remove that word from `test.html` on disk (simulating the worker's edit) and set the ticket `"status":"done"` in `.cc-htmlfeedback/state.json`.
3. After the `tickets` SSE event, assert in the tab:

```js
(() => ({
  textGone: !document.body.innerText.includes('UNIQUE_REMOVED_WORD'),
  widgetAlive: !!document.getElementById('fb-panel') && !!document.getElementById('fb-launch'),
  noReloadFlag: window.__ccfbMorphedOnce === undefined ? 'n/a' : true,
  scrollPreserved: Math.abs(window.scrollY - window.__savedScrollY) < 5
}))()
```

(Before step 1, set `window.__savedScrollY = window.scrollY` in the tab.) Expected: `textGone:true`, `widgetAlive:true`, `scrollPreserved:true`, and the page did NOT navigate/reload (panel state and scroll intact).

- [ ] **Step 7: Browser-verify proxy mode does NOT morph**

Stop the static server. Start a trivial upstream (`node server.js --root . --port 5599` as a stand-in dev server) and run the widget server in proxy mode: `node server.js --proxy http://127.0.0.1:5599 --port 4321`. Open `http://127.0.0.1:4321/test.html` (now `__CCFB.mode==='proxy'`). Repeat the done flow and assert no morph fetch fires:

```js
({ mode: window.__CCFB && window.__CCFB.mode })   // expect "proxy"
```

Expected: `mode:"proxy"`; on `done` the widget updates the panel pill/badge but does not call `applyMorph` (page content unchanged by the widget — confirm by leaving upstream file edited and seeing the widget leave it to the upstream).

- [ ] **Step 8: Commit**

```bash
git add feedback-widget.html extension/feedback-widget.js dist/feedback-widget.js dist/feedback-bookmarklet.txt dist/install-bookmarklet.html
git commit -m "feat: apply verified change on done via DOM morph (static) / defer to HMR (proxy); remove reload"
```

---

## Task 5: Judge validates in a separate tab/window

These edit the **user-level** skill (canonical copy; not under this repo's git). Verification is by reading the files back.

**Files:**
- Modify: `~/.claude/skills/cc-htmlfeedback/SKILL.md` (drain-loop step 6, "Judge")
- Modify: `~/.claude/skills/cc-htmlfeedback/judge-prompt.md` (step 1)

- [ ] **Step 1: Update the judge step in `SKILL.md`**

In the "Judge" step (currently: "Use the `Agent` tool, `subagent_type: \"general-purpose\"`."), add a bullet immediately after it:

```markdown
   - ISOLATION: the user's live tab (the one opened at Start) is sacred. The judge MUST
     open a NEW tab/window with `mcp__claude-in-chrome__tabs_create_mcp` for validation
     and navigate/reload/inspect only that tab — never the user's tab. Close the judge
     tab when done (or leave it), but never touch the user's tab.
```

- [ ] **Step 2: Update `judge-prompt.md` step 1**

Replace step 1 ("Open `{{PAGE}}` in Chrome using the `mcp__claude-in-chrome__*` tools (create a tab, navigate, …)") with:

```markdown
1. Open `{{PAGE}}` in a **NEW, dedicated tab** using `mcp__claude-in-chrome__tabs_create_mcp`
   (then navigate it). NEVER reuse or navigate the user's existing tab — they are actively
   commenting and navigating in it. Do all inspection/screenshots in your own tab.
```

- [ ] **Step 3: Verify the edits landed**

Run: `grep -n "tabs_create_mcp" ~/.claude/skills/cc-htmlfeedback/SKILL.md ~/.claude/skills/cc-htmlfeedback/judge-prompt.md`
Expected: a match in each file.

(No git commit — user-level skill files are outside this repo. Note in the PR/summary that the skill was updated.)

---

## Task 6: Event-driven background watcher (no 60s foreground poll)

**Files:**
- Modify: `~/.claude/skills/cc-htmlfeedback/SKILL.md` (drain-loop "Pick" step, the `watch-inbox.js` call)

- [ ] **Step 1: Update the wait step in `SKILL.md`**

Replace the bullet:

```markdown
   - Run `node $TOOLING/lib/watch-inbox.js <QUEUE> <currentInboxLineCount> 60000`. It blocks until a new
     line appears (prints the new ticket JSON) or times out (~60s, prints nothing).
```

with:

```markdown
   - Run `node $TOOLING/lib/watch-inbox.js <QUEUE> <currentInboxLineCount> 1800000` as a
     **background task** (`Bash` with `run_in_background: true`). The harness re-invokes you
     the moment it exits — i.e. when a real comment arrives (`fs.watch` fires). Between
     comments you stay idle: no periodic wake, no token cost. The 30-min timeout is only a
     liveness heartbeat; `/cc-htmlfeedback stop` interrupts the idle session as a normal
     message, so no short poll is needed. On wake, merge new inbox tickets and re-arm a
     fresh background watcher.
```

- [ ] **Step 2: Verify the edit landed**

Run: `grep -n "run_in_background\|1800000" ~/.claude/skills/cc-htmlfeedback/SKILL.md`
Expected: a match (background watcher described, 30-min heartbeat).

(No git commit — user-level skill file.)

---

## Task 7: Full end-to-end integration verification (Chrome)

**Files:** none (verification only).

- [ ] **Step 1: Run the spec's 8-step E2E**

Per the spec "Verification" section, with `node server.js --root . --port 4321` and a fresh tab on `http://127.0.0.1:4321/test.html`:
1. Scroll down + focus somewhere.
2. Submit a strike comment → strikethrough appears immediately, badge increments, ticket `todo`. No DOM change through `todo`/`in-progress`.
3. Edit source + judge in a SEPARATE tab; on `done` the user's tab **morphs** (no reload): struck text removed, scroll + focus preserved, badge decrements.
4. All tickets `done` → badge `0`.
5. Widget panel + open-ticket marks survive the morph.
6. Idle: no ~60s wake turns; wakes promptly on next comment.
7. Compose a comment while a ticket finishes → morph defers until the composer closes.
8. Proxy mode: widget does NOT morph; upstream HMR updates the page; panel/badge still update.

- [ ] **Step 2: Clean up**

```bash
pkill -f "server.js --root . --port 4321" 2>/dev/null; true
# remove any throwaway test edits to test.html / .cc-htmlfeedback used during verification (use git checkout / trash, not rm)
```

- [ ] **Step 3: Final commit (if any verification-driven fixes were made)**

```bash
git add -A && git commit -m "test: end-to-end verification of live-tab morph + event-driven loop"
```

---

## Self-review notes

- **Spec coverage:** Change 1 → Task 2; Change 2 (morph, no reload, static/proxy, Idiomorph, mark re-anchor, defer-while-composing) → Tasks 3+4 (+ mode flag in Task 1); Change 3 → Task 5; Change 4 → Task 6; spec Verification → Task 7. The spec's "inline Idiomorph may need build size-budget tweak" is covered by Task 3 Step 3 (`build.js --check` must still pass; build.js has no hard size cap, only a >100-char floor, so inlining is safe).
- **Type/name consistency:** `applyMorph()`, `scheduleApply()`, `pendingApply`, `isComposing()`, `isWidgetEl()`, `unwrapAllMarks()` are defined in Task 4 Step 3 and referenced consistently in Steps 1/2/4. `__CCFB.mode` is produced in Task 1 and consumed in Task 4 `scheduleApply()`. Idiomorph is referenced as `window.Idiomorph` in both Task 3 and Task 4.
- **No placeholders** except the explicit, unavoidable vendored-library paste in Task 3 Step 2 (third-party minified source fetched at execution time) — marked clearly with `<<PASTE …>>` and an exact source URL/version.
