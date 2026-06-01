# cc-htmlfeedback — live-tab non-interference & event-driven loop

**Date:** 2026-06-01
**Status:** Approved (design) — pending implementation plan

## Problem

The current loop interferes with the user while they keep using the same page to
comment and navigate (e.g. a presentation), and it re-evaluates on a 60-second
timer even when idle:

1. The counter badge counts every non-discarded ticket, so finishing a task never
   reduces it — completing everything does not return the badge to `0`.
2. Every source-file save triggers a full `location.reload()` in the user's tab
   (via the `reload` SSE event), wiping scroll position, the current presentation
   slide, the open comment composer, and undo history.
3. Nothing guarantees the verification judge opens a *separate* tab; it can reload
   or navigate the user's live tab.
4. The worker waits with a foreground `watch-inbox.js` call that times out every
   60s, burning a Claude turn (and tokens) on every idle minute.

## Goals

Make the user's live tab a "sacred" surface that is never disturbed mid-work, tie
every visible change to ticket status, isolate validation, and make the loop wake
only on real events.

Non-goals: multi-app / multi-session support; previewing non-deletion edits
(reword, restyle) before they land — those simply appear at the `done` reload.

## Ticket lifecycle (the user's live tab)

| Transition            | DOM in the user's tab                                              |
|-----------------------|-------------------------------------------------------------------|
| comment submitted     | strikethrough (strike type) or marker (comment type) appears immediately; ticket created `todo` |
| `todo`                | no further DOM change                                             |
| `in-progress`         | no DOM change (only the panel status pill updates)               |
| `done`                | **lazy full reload** → tab now shows the real, verified source   |
| `error`               | no DOM change; stays counted as outstanding                      |

The immediate-strikethrough-on-submit behavior already exists and is unchanged.
The **only** DOM mutation to the page itself, across a ticket's whole life, is the
single reload at `done`.

## Change 1 — counter shows non-done tickets

**File:** `feedback-widget.html` (`render()`).

The badge (`#fb-launch .fb-badge`), the panel count (`#fb-count` "N notes"), the
`has` class on the launcher, and the empty-state visibility derive from the count
of **outstanding** tickets: non-discarded AND status `!== 'done'`.

- `todo`, `in-progress`, `error` → counted.
- `done` → not counted.
- All tickets `done` → badge shows `0`, `has` (red dot) clears, panel reads `0 notes`.

`done` tickets remain in the panel list as history (with their `done` pill); they
are excluded from the count only. Implementation note: today `visibleItems()` is
used both for the rendered list and the count. Introduce an `outstandingCount`
(filter `visibleItems()` by `statusOf(f) !== 'done'`) for the badge/count, while the
list keeps rendering all `visibleItems()`.

## Change 2 — lazy reload tied to `done` (with restore + defer)

**File:** `feedback-widget.html` (SSE handlers + `reconcile()`).

1. **Stop reloading on file change.** The `reload` SSE listener must no longer call
   `location.reload()`. File saves by the worker no longer touch the user's tab.
   (The server may keep emitting the event; the widget ignores it for the live tab.)
2. **Reload on `done` transition.** In `reconcile()`, when a ticket's status changes
   *into* `done` (was not `done` before this reconcile, is `done` now), schedule a
   reload of the user's tab. The `done` status is written by the worker only after
   the source edit is saved and the judge passes, so the reload always loads the
   final, verified file.
3. **Restore position (best-effort).** Before reloading, persist `window.scrollY`
   (and `scrollX`) to `sessionStorage`; on load, restore them. `location.hash` is
   left intact (most slide frameworks, e.g. reveal.js, track the current slide via
   the hash, which the browser preserves across `location.reload()`), so the current
   slide is restored for hash-based decks. Restoration is best-effort: if the DOM
   changed enough that the saved offset is meaningless, we simply land at top.
4. **Defer while composing.** If the comment composer (`#fb-text`) or a card note
   (contentEditable) is focused, or the composer has unsaved text, do **not** reload.
   Set a `pendingReload` flag and a one-shot listener; perform the reload when the
   composer/note blurs or closes. Multiple `done`s while composing collapse into a
   single pending reload.

Edge cases:
- After the reload, `reconcile()` + `reanchor()` rebuild marks from server state:
  still-open strike tickets re-anchor (their text is still present); a `done`
  removal finds no anchor (text gone) and shows no mark — correct.
- If several tickets finish close together, each `done` requests a reload; a reload
  already in flight (or a single `pendingReload`) absorbs the rest — at most one
  reload per "batch."

## Change 3 — judge validates in a separate tab/window

**Files:** `~/.claude/skills/cc-htmlfeedback/SKILL.md`, `judge-prompt.md`.

- The worker keeps the tab opened at **Start** as the user's tab and never reuses it
  for validation.
- The judge agent is instructed to **always create a fresh tab** (or window) with
  `mcp__claude-in-chrome__tabs_create_mcp` for validation, navigate/​reload/​inspect
  only that tab, and close it (or leave it) without ever touching the user's tab.
- `judge-prompt.md` gains an explicit "open a NEW tab; never use the user's tab"
  instruction in its step 1.

## Change 4 — event-driven background watcher (no 60s polling)

**File:** `~/.claude/skills/cc-htmlfeedback/SKILL.md` (drain-loop wait step).

When there is no `todo` ticket, instead of a foreground 60s call, the worker runs
the watcher as a **background task**:

```
node $TOOLING/lib/watch-inbox.js <QUEUE> <currentInboxLineCount> 1800000   # run_in_background: true
```

- The harness re-invokes the session the moment the watcher **exits** — i.e. when a
  real comment arrives (`fs.watch` fires). Between comments the session is idle:
  zero turns, zero tokens.
- On wake, the worker merges new inbox tickets into `state.json` as `todo`, processes
  them, then re-arms a fresh background watcher.
- The `1800000` (30 min) timeout is only a liveness heartbeat; it is no longer needed
  for stop-responsiveness because `/cc-htmlfeedback stop` arrives as a normal user
  message that interrupts the idle session.

`watch-inbox.js` itself needs no code change — only how the worker invokes it
(background vs foreground, longer timeout).

## Files touched

- `feedback-widget.html` — counter (Change 1), SSE/reload logic (Change 2). This is
  the built widget source; if `extension/feedback-widget.js` / `dist/` are produced
  from it via `build.js`, rebuild after editing.
- `~/.claude/skills/cc-htmlfeedback/SKILL.md` — judge isolation (Change 3),
  background watcher (Change 4).
- `~/.claude/skills/cc-htmlfeedback/judge-prompt.md` — new-tab instruction (Change 3).

## Verification

Per the project's testing rule, the loop must be exercised end-to-end in Chrome:
1. Serve a multi-section/slide page, open it as the user's tab, scroll/navigate.
2. Submit a strike comment → strikethrough appears immediately, badge increments,
   ticket `todo`. No reload through `todo`/`in-progress`.
3. Worker applies the edit; judge runs in a **separate** tab; on `done` the user's
   tab reloads once, scroll/slide restored, text actually removed, badge decrements.
4. With all tickets `done`, badge reads `0`.
5. While idle, confirm the session produces no ~60s wake turns and wakes promptly on
   the next comment.
6. Submit a comment while typing in the composer → confirm a concurrent `done` defers
   its reload until the composer closes.
