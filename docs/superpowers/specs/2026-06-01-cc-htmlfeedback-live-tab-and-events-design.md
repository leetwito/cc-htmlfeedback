# cc-htmlfeedback — live-tab, multi-file, event-driven loop (v2)

**Date:** 2026-06-01
**Status:** Approved (design) — pending implementation plan

## Problem

The loop interferes with the user while they keep using the same page to comment and
navigate, polls on a 60-second timer, supports only one file, splits its data across
two opaquely-named files, and never surfaces leftover work. v2 makes the live tab
non-interfering, supports many files worked concurrently in one session, makes the loop
event-driven, and improves the widget UX and startup behavior.

## Goals & non-goals

**Goals:** the user's live tab is never disturbed mid-work; visible changes are tied to
ticket status; validation is isolated to a separate tab; the loop wakes only on real
events; one session handles many files concurrently; the widget UI is organized and
resettable; startup surfaces outstanding work.

**Non-goals:** previewing non-deletion edits (reword/restyle) before they land — those
appear at the `done` morph; multiple independent sessions/servers (we use one session,
many tabs); cross-machine/remote use.

## Architecture overview

One companion server (`server.js`) serves the user's files (static `--root`, or `--proxy`
wrapping a dev server) and injects the widget. The user opens **multiple files, one
browser tab each**. All feedback flows through a **per-page** queue under
`<servedRoot>/.cc-htmlfeedback/`. One Claude **worker session** drains the queue, fixing
independent files **concurrently** via parallel subagents. The judge validates in its own
tab. The user's tabs are never reloaded — verified changes are applied by **DOM morphing**
(static) or deferred to the upstream **HMR** (proxy).

### Per-page queue layout

```
<servedRoot>/.cc-htmlfeedback/
  index.json                      # { "<pagekey>": { page, file }, ... } — written by the server
  pages/<pagekey>/
    feedback_inbox.jsonl          # append-only, SERVER-written: raw incoming comments for this page
    feedback_tasks.json           # the board for this page, WORKER-written: { version, page, file, tickets:[...] }
```

- `pagekey = sha1(pageURL).slice(0,12)` (stable, collision-safe, filesystem-safe). The
  human-readable `page` (full URL) and `file` (root-relative path) live in `index.json`
  and inside each `feedback_tasks.json`.
- **Single-writer-per-file** is preserved and now also isolates files from each other:
  the server only ever *appends* to a page's `feedback_inbox.jsonl`; the worker is the
  only writer of each `feedback_tasks.json`. Two subagents fixing two different files
  write two different board files → concurrent fixes are race-free by construction.

### Why `feedback_inbox.jsonl` + `feedback_tasks.json` (the rename)

`inbox.jsonl` → `feedback_inbox.<page>.jsonl` (server-owned intake channel) and
`state.json` → `feedback_tasks.json` (worker-owned board). The two-file split is the
lock: the server (handling browser POSTs) and the worker (a Claude session editing files)
run concurrently; append-only intake + single-writer board avoids cross-process clobber.
They are **not** merged into one file — that would reintroduce the two-writer race.

Statuses: `todo → in-progress → done` (or `error`). Refinement is a *new* comment.

## Ticket lifecycle (the user's live tab)

| Transition        | DOM in the user's tab                                                            |
|-------------------|----------------------------------------------------------------------------------|
| comment submitted | strikethrough (strike) or marker (comment) appears immediately; ticket `todo`    |
| `todo`            | no further DOM change                                                            |
| `in-progress`     | no content/structural change; the existing mark gains a subtle "working" animation (Change 11); panel status pill updates |
| `done`            | **DOM morph** (static) / upstream **HMR** (proxy) → verified change shown, scroll/focus/state preserved; **no reload, ever** |
| `error`           | no DOM change; stays counted as outstanding                                      |

---

## Change 1 — counter shows only non-done tickets

**File:** `feedback-widget.html` (`render()`).

Badge (`#fb-launch .fb-badge`), panel count (`#fb-count`), the `has` launcher class, and
empty-state derive from **outstanding** = non-discarded AND status `!== 'done'`. `done`
tickets remain in the panel (as history, in their collapsed section — Change 8) but are
not counted. `todo`+`in-progress`+`error` count; all `done` → badge `0`. In disconnected
mode `statusOf()` is null so nothing is excluded (count = all).

## Change 2 — apply on `done` via DOM morphing (no reload, ever)

**Files:** `feedback-widget.html` (SSE + `reconcile()`), inlined [Idiomorph](https://github.com/bigskysoftware/idiomorph).

`location.reload()` is removed entirely (not a fallback). Idiomorph is **inlined** into
the widget IIFE (build.js forbids a second `<script>`); it exposes `window.Idiomorph`.

- **Static mode:** ignore file-change SSE; on a ticket's transition *into* `done`, fetch
  the page (its own `location.href`, cache-busted), unwrap `.fb-mark` spans, morph
  `document.body` with `{morphStyle:'innerHTML', restoreFocus:true, ignoreActiveValue:true}`
  and `beforeNodeRemoved`/`beforeNodeMorphed` callbacks that skip the widget's own nodes
  (`#fb-launch/#fb-panel/#fb-toast/#fb-popover`), then re-anchor marks for still-open
  tickets via the existing `reanchor()`. Defer the morph while the user is composing
  (`#fb-text` focused / has draft, or a `.fb-note` is being edited); flush on close.
- **Proxy mode** (`__CCFB.mode === 'proxy'`): do **not** morph; the upstream dev server's
  HMR updates the page. Only update the panel pills/counter.
- **On morph failure:** `console.warn` and leave the page as-is; never reload.

Rationale recap (why not "just use Vite's HMR"): primary targets are static
HTML/decks/exported sites with no dev server; Vite full-reloads on HTML/content edits and
needs `import.meta.hot.accept` boundaries; Vite provides transport, not a DOM-preserving
apply. Morphing (static) + deferring to HMR (proxy) are complementary, not competing.

## Change 3 — judge validates in a separate tab/window

**Files:** `~/.claude/skills/cc-htmlfeedback/SKILL.md`, `judge-prompt.md`.

The worker keeps each user tab sacred. The judge agent **always** opens a fresh tab with
`mcp__claude-in-chrome__tabs_create_mcp` and inspects only that tab; never reuses/navigates
a user tab. `judge-prompt.md` step 1 says so explicitly.

## Change 4 — event-driven background watcher (no 60s poll)

**Files:** `~/.claude/skills/cc-htmlfeedback/SKILL.md`, `lib/watch-inbox.js`.

`watch-inbox.js` watches the **whole queue tree** (`.cc-htmlfeedback/`, recursively) and
exits when any `feedback_inbox.jsonl` changes (or on a long timeout). The worker runs it
as a **background task** (`run_in_background: true`); the harness re-invokes the session
when it exits — i.e. a real comment arrived on *some* page. Idle between comments = zero
turns. On wake the worker re-scans all pages, merges new inbox lines into the right per-
page board, processes, and re-arms. The 30-min timeout is only a heartbeat (`stop`
interrupts the idle session as a normal message). On Linux, recursive `fs.watch` is
unreliable — fall back to watching the root plus each page subdir (documented in the lib).

## Change 5 — startup outstanding-feedback check

**File:** `~/.claude/skills/cc-htmlfeedback/SKILL.md` (Start sequence).

On `/cc-htmlfeedback`, before draining: scan all per-page boards. If any non-`done`
tickets exist, summarize them grouped by **page** then **status** (counts + one-line each),
and ask the user how to proceed:
- **Resume** the `todo`/`in-progress` items (default),
- **Explain/retry** each `error` (show its `result` reason),
- **Clean** — clear `done` history, or wipe a page's board for a fresh start.
Then enter the drain loop.

## Change 6 — multi-file: one session, many tabs, concurrent fixes

**Files:** `server.js`, `lib/queue.js`, `lib/watch-inbox.js`, `SKILL.md`.

- **Server routing:** a comment POST includes `page`. The server computes `pagekey`,
  creates `pages/<pagekey>/` + an `index.json` entry on first sight, and appends to that
  page's `feedback_inbox.jsonl`. `GET /__ccfb/tickets?page=<url>` returns that page's
  board; `GET /__ccfb/events?page=<url>` streams that page's board changes. (Endpoints
  become page-scoped; the widget passes its own `location.href`.)
- **Worker concurrency:** the drain loop collects `todo` tickets across all pages and fans
  **independent** tickets (distinct files) out to parallel subagents (`Agent` tool), each
  doing locate → edit → (page tab morphs on `done`) → judge-in-separate-tab → write *that
  page's* board. Per-file boards make these writes non-conflicting. Cap concurrency
  (e.g. ≤ 4). Two tickets on the **same** file are serialized.
- **Browser:** one tab per page (the user opens them); the worker tracks which tab is
  which page so it can confirm a page is open before morph-relevant work.

## Change 7 — file rename (board/inbox)

**Files:** `lib/queue.js` (paths), `server.js`, `SKILL.md`, tests.

`lib/queue.js` exposes per-page path helpers: `pageKey(pageUrl)`,
`inboxPath(queueDir, pageKey)`, `tasksPath(queueDir, pageKey)`, `indexPath(queueDir)`,
plus `newTicket`. Old single-file `inbox.jsonl`/`state.json` are replaced. The board JSON
shape gains `page` and `file` alongside `version` and `tickets`.

## Change 8 — sidebar: collapsible sections per status, Done collapsed

**File:** `feedback-widget.html` (`render()` + CSS + markup).

The flat sorted list becomes grouped collapsible sections in this order: **In progress**,
**To do**, **Error**, **Done**. Each section header shows its count and toggles its body
(`<details>`/`<summary>` or a class toggle). **Done starts collapsed**; the others start
expanded. Empty sections are hidden. Section open/closed state persists across re-renders
(don't rebuild a section the user toggled). In disconnected mode (no statuses) fall back to
a single un-sectioned list.

## Change 9 — Clean button (wipes this page's tasks)

**Files:** `feedback-widget.html` (button + handler), `server.js` (`POST /__ccfb/clean`),
`lib/queue.js`.

A `Clean` button in the panel header, **confirm-guarded** (in-widget inline confirm, not a
native `confirm()` dialog — native dialogs block the extension). On confirm it
`POST /__ccfb/clean {page: location.href}`; the server truncates **that page's**
`feedback_inbox.jsonl` and `feedback_tasks.json` and broadcasts an empty board over SSE;
the widget clears its local store, removes marks, and re-renders to empty. Scope is the
current page only — other pages' boards are untouched. (Clean is a deliberate reset;
because the targeted page's worker is typically idle at clean time, the server truncating
the board is acceptable; the worker treats the empty board as authoritative on next scan.)

## Change 10 — suppress host-page hotkeys while the composer is open

**File:** `feedback-widget.html` (key-event handling on the widget containers).

When the selection popover (`#fb-popover`) is open or a `.fb-note` is being edited, the
user is typing feedback — keystrokes must NOT trigger the host page's global shortcuts
(e.g. a deck's `f` = fullscreen, arrows/space = next slide). Stop `keydown`, `keyup`, and
`keypress` from propagating out of the widget containers (`#fb-popover`, `#fb-panel`) via
bubble-phase `e.stopPropagation()` on those elements. The widget's own shortcuts (Enter to
submit, Esc to close, Backspace-to-strike, ⌘/Ctrl+C) still fire because they run at the
target before the container stops propagation; `preventDefault` is NOT used, so normal
typing is unaffected. Caveat: hosts that bind global keys in the *capture* phase on
`document`/`window` (rare) won't be blocked by bubble-phase stopping; documented as a known
limitation, acceptable for the common case (reveal.js and most decks listen in bubble).

## Change 11 — "working" animation on in-progress marks

**File:** `feedback-widget.html` (CSS + the per-status mark update).

While a ticket is `in-progress`, its on-page mark (the `.fb-mark` highlight or
`.fb-mark.strike` strikethrough) shows a subtle loading animation so the user can see an
agent is actively working on that exact text. Implementation: toggle a `.fb-working` class
on the content mark span(s) for that ticket id whenever `statusOf(f) === 'in-progress'`,
and remove it on any other status. CSS animates `.fb-working` as a gentle pulsing shimmer
(e.g. an animated background-position gradient or pulsing opacity) — **no layout shift, no
color change to the underlying text**, and wrapped in `@media (prefers-reduced-motion:
reduce)` to fall back to a static tint. Marks are re-derived on morph/re-anchor, so the
class is applied during `render()`/`applyStatus()` from the ticket's current status (not
stored on the node). This is purely decorative and additive — it does not alter page
content (which still changes only at `done`).

## Files touched (summary)

- `feedback-widget.html` — Changes 1, 2, 8, 9, 10, 11 (+ inlined Idiomorph); rebuild via
  `node build.js`, verify `node build.js --check`. Built artifact `extension/feedback-widget.js` is what the server serves.
- `lib/queue.js` — per-page path helpers + board shape (Changes 6, 7).
- `lib/inject.js` — `mode` flag in `__CCFB` (Change 2 proxy/static branch).
- `lib/watch-inbox.js` — watch the queue tree, wake on any inbox change (Changes 4, 6).
- `server.js` — page-scoped routing/endpoints, `mode`, `clean` endpoint (Changes 2, 6, 9).
- `~/.claude/skills/cc-htmlfeedback/SKILL.md` — startup check, multi-file drain with
  parallel subagents, background watcher, judge isolation (Changes 3, 4, 5, 6).
- `~/.claude/skills/cc-htmlfeedback/judge-prompt.md` — separate-tab instruction (Change 3).
- `test/*.test.js` — extend `inject`, `queue`, `server`, `watch-inbox` tests for the above.

## Verification (end-to-end in Chrome)

1. Serve a dir with ≥2 HTML files; open each in its own tab (multi-file).
2. Comment on both pages → strikethrough/marker appears immediately; per-page badges
   increment; per-page boards created under `pages/<pagekey>/`. No content change through
   `todo`/`in-progress` (the in-progress "working" animation is the only mark change).
3. Worker fixes both pages **concurrently** (parallel subagents); judge runs in a separate
   tab per ticket; on each `done` the relevant tab **morphs** (no reload) — text changed,
   scroll/focus preserved, widget + open-ticket marks survive.
4. While a ticket is `in-progress`, its on-page mark shows the pulsing "working" animation;
   it stops when the ticket leaves `in-progress`. (Reduced-motion → static tint.)
5. All `done` on a page → its badge `0`; `done` tickets sit in the collapsed Done section.
6. Collapsible sections: Done starts collapsed; toggling persists across re-renders.
7. Clean button on page A → page A board empties (inbox + tasks truncated, marks gone);
   page B untouched.
8. Idle: no ~60s wake turns; the session wakes promptly on the next comment on any page.
9. Compose a comment while a ticket finishes → that page's morph defers until the composer
   closes.
10. Startup: re-run `/cc-htmlfeedback` with leftover non-done tickets → it summarizes them
    grouped by page+status and offers resume / explain-errors / clean.
11. Proxy mode: widget does not morph; upstream HMR updates the page; panel/badge update.
