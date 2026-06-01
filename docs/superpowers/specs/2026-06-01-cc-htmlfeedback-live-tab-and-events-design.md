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
(reword, restyle) before they land — those simply appear at the `done` morph.

## Ticket lifecycle (the user's live tab)

| Transition            | DOM in the user's tab                                              |
|-----------------------|-------------------------------------------------------------------|
| comment submitted     | strikethrough (strike type) or marker (comment type) appears immediately; ticket created `todo` |
| `todo`                | no further DOM change                                             |
| `in-progress`         | no DOM change (only the panel status pill updates)               |
| `done`                | **DOM morph** (static mode) / upstream HMR (proxy mode) → tab now shows the real, verified source, with scroll/focus/state preserved; no reload |
| `error`               | no DOM change; stays counted as outstanding                      |

The immediate-strikethrough-on-submit behavior already exists and is unchanged.
The **only** DOM mutation to the page itself, across a ticket's whole life, is the
single morph at `done` (see Change 2). There is **no full page reload at any point** —
`location.reload()` is removed entirely, not kept as a fallback.

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

## Change 2 — apply the change on `done` via DOM morphing (no reload, ever)

**Files:** `feedback-widget.html` (SSE handlers + `reconcile()`), plus an inlined copy
of [Idiomorph](https://github.com/bigskysoftware/idiomorph) in the widget source.

The general technique for "apply a change to a live page with minimal interference" is
**DOM morphing**: fetch the updated HTML, diff it against the live DOM, and patch only
the nodes that actually changed — leaving scroll, focus, input values, media, and
untouched JS state in place. This is what Turbo 8 / Hotwire adopted for smooth page
refreshes. We use **Idiomorph** (Turbo switched to it from morphdom; on-by-default
`restoreFocus`; dependency-free and tiny, so it is **inlined into the widget** — the
widget stays self-contained). `location.reload()` is removed entirely — not a fallback.

The update path depends on the serving mode (see "Static vs proxy mode" below):

### Static mode (`--root`) — the widget morphs

1. **Ignore file-change events.** The `reload` SSE listener must no longer call
   `location.reload()`. Worker file saves do not touch the user's tab on their own.
2. **Morph on `done` transition.** In `reconcile()`, when a ticket changes *into*
   `done` (was not `done` before, is now), fetch the served page URL (cache-busted),
   parse it, and morph the live `<body>`:
   ```
   Idiomorph.morph(document.body, newBodyHTML, {
     morphStyle: 'innerHTML', restoreFocus: true, ignoreActiveValue: true,
     callbacks: { /* skip the widget's own nodes — see below */ }
   })
   ```
   `done` is written by the worker only after the edit is saved and the judge passes,
   so the fetched HTML is always the final, verified source.
3. **Protect the widget's own DOM.** The widget's injected nodes (`#fb-panel`,
   `#fb-launch`, `#fb-toast`, `#fb-popover`) and the runtime `.fb-mark` spans are NOT
   in the served source, so a naïve morph would delete them. Before morphing, **unwrap
   all `.fb-mark` spans** (restore plain text); use `beforeNodeRemoved`/​
   `beforeNodeMorphed` returning `false` to skip the widget root nodes; after morphing,
   **re-anchor** marks for still-open tickets via the existing `reanchor()`. Marks are
   a projection of open tickets onto the DOM, recomputed after each structural change.
4. **Defer while composing.** If the comment composer (`#fb-text`) or a card note is
   focused / has unsaved text, set a `pendingMorph` flag and morph on blur/close.
   `ignoreActiveValue` additionally protects the focused field during a morph.
5. **On morph failure.** Log a console warning and leave the page as-is. The edit is
   safely in the file and appears on the user's next manual navigation. Never hard-reload.

### Proxy mode (`--proxy`) — defer to the upstream dev server's HMR

The wrapped dev server (e.g. Vite) already hot-updates the page over its own channel.
The widget does **not** morph or reload on `done`; it only updates the panel's status
pills and counter. Morphing here would fight the upstream HMR.

Edge cases:
- Morphing preserves the current presentation slide / scroll / focus *inherently*
  (it doesn't reload), so no hash- or framework-specific logic is needed.
- A `done` removal: the struck text is gone in the new HTML, so the morph removes it
  and its (already unwrapped) mark does not re-anchor — correct.
- Several tickets finishing close together: coalesce into one morph (a morph already
  scheduled / `pendingMorph` absorbs the rest); a single fetch reflects all saved edits.

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

- `feedback-widget.html` — counter (Change 1), SSE handling + morph-on-`done` and the
  inlined Idiomorph source (Change 2). This is the built widget source; rebuild
  `extension/feedback-widget.js` + `dist/*` via `node build.js` after editing. Note the
  build's size budget / `--check` may need updating for the inlined Idiomorph (~a few KB).
- `~/.claude/skills/cc-htmlfeedback/SKILL.md` — judge isolation (Change 3),
  background watcher (Change 4).
- `~/.claude/skills/cc-htmlfeedback/judge-prompt.md` — new-tab instruction (Change 3).

## Verification

Per the project's testing rule, the loop must be exercised end-to-end in Chrome:
1. Serve a multi-section/scrollable page (static mode), open it as the user's tab,
   scroll down and focus somewhere.
2. Submit a strike comment → strikethrough appears immediately, badge increments,
   ticket `todo`. No DOM change through `todo`/`in-progress`.
3. Worker applies the edit; judge runs in a **separate** tab; on `done` the user's tab
   **morphs** (no reload) — struck text actually removed, scroll position and focus
   preserved, badge decrements.
4. With all tickets `done`, badge reads `0`.
5. Confirm the widget's own panel/marks survive the morph (not deleted).
6. While idle, confirm the session produces no ~60s wake turns and wakes promptly on
   the next comment.
7. Submit a comment while typing in the composer → confirm a concurrent `done` defers
   its morph until the composer closes.
8. Proxy mode (wrap a Vite dev server): confirm the widget does **not** morph on `done`
   and lets Vite's HMR update the page; panel status/counter still update.
