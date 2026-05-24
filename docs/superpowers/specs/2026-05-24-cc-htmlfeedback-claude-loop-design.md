# cc-htmlfeedback — live Claude Code feedback loop

**Date:** 2026-05-24
**Status:** Approved design (pre-implementation)
**Topic:** Turn the in-page feedback tool into a live work queue that a Claude Code session drains — comment → fix → hot reload — with the sidebar acting as a todo/in-progress/done board.

---

## 1. Goal

Today cc-htmlfeedback is an *export* tool: highlight text, write a comment, copy structured feedback, paste it to Claude. This design removes the copy-paste. A submitted comment is sent to the **same Claude Code session** that launched the dev server; the session edits the app's source; the dev server **hot-reloads** the page; and each comment lives in the sidebar as a **ticket** that moves `todo → in-progress → done` automatically.

Success criteria:
- From a running app, a developer highlights an element, writes "make this button blue", submits, and within seconds the page reloads with the change and the ticket shows `done` — no copy-paste, no manual prompt.
- The loop runs inside the developer's existing Claude Code session, started by an explicit trigger.
- Fixes auto-apply; git is the undo path.

## 2. Two modes (one widget)

The widget gains a transport abstraction selected at load time:

- **Standalone mode** (existing, unchanged): extension / bookmarklet / drop-in. "Submit" → in-memory store + clipboard export. No statuses.
- **Connected mode** (new): the companion server injects the widget with `window.__CCFB = { endpoint, sessionId }`. "Submit" → POST to the server; status flows back over SSE; the sidebar shows ticket states.

`window.__CCFB` presence is the only switch. All existing standalone behavior is preserved.

## 3. Architecture (Approach B — companion server + SSE, file as the contract)

The session never speaks HTTP. A JSON-on-disk queue is the contract between Claude and everything else; a small companion server handles the parts the session can't (browser transport + reload triggers).

```mermaid
flowchart LR
  W["cc-htmlfeedback widget<br/>(injected by server)"]
  S["companion server<br/>REST + SSE + file-watch + live-reload"]
  IN[("inbox.jsonl<br/>append-only — server writes")]
  ST[("state.json<br/>session writes")]
  L["Claude Code session<br/>(listening loop)"]
  SRC[("your app source")]

  W -- "POST /__ccfb/tickets" --> S
  S -- "append line" --> IN
  L -- "read new lines" --> IN
  L -- "edit source" --> SRC
  L -- "write status/result" --> ST
  S -. "fs.watch" .-> ST
  S -- "SSE: status + reload" --> W
  SRC -. "fs.watch" .-> S
```

**Single-writer ownership** eliminates file contention: the server only ever *appends* to `inbox.jsonl`; the session only ever *writes* `state.json`. No locks needed.

## 4. Data model

Directory: `.cc-htmlfeedback/` at the project root, gitignored.

**`inbox.jsonl`** — append-only, one JSON object per line, written by the server on each `POST /__ccfb/tickets`:

```json
{"id":"<uuid>","type":"comment","quote":"Save","context":"...","section":"Settings","note":"make this button blue","page":"http://localhost:5173/settings","createdAt":1716500000000}
```

**`state.json`** — the canonical ticket list, written by the session:

```json
{
  "version": 1,
  "sessionId": "<uuid>",
  "page": "http://localhost:5173/",
  "tickets": [
    {
      "id": "<uuid>",
      "type": "comment",            // "comment" | "strike"
      "status": "done",             // "todo" | "in-progress" | "done" | "error"
      "quote": "Save",
      "context": "...surrounding block text...",
      "section": "Settings",
      "note": "make this button blue",
      "page": "http://localhost:5173/settings",
      "files": ["src/Settings.tsx"], // files touched (transparency)
      "result": "Changed Save button to blue (bg-blue-600).",
      "createdAt": 1716500000000,
      "updatedAt": 1716500003000
    }
  ]
}
```

`quote` / `context` / `section` serve double duty: the human-readable anchor in the sidebar, and how the session locates the source (grep the `quote` across the served root, disambiguated by `section`/`context`).

## 5. Companion server (`server.js`)

Small Node program (standard library only where feasible), started in the background by the trigger.

**Serving modes:**
- `--root <dir>` — serve static files from a directory (plain HTML apps).
- `--proxy <devUrl>` — reverse-proxy an existing dev server (Vite/Next/etc.) so its native HMR keeps working; the server only injects the widget and relays events.

**Widget injection:** rewrite served HTML responses to insert, before `</body>`:
```html
<script>window.__CCFB={endpoint:"",sessionId:"<uuid>"};</script>
<script src="/__ccfb/widget.js"></script>
```

**Endpoints:**
- `POST /__ccfb/tickets` → validate, assign `id`/`createdAt`, append one line to `inbox.jsonl`, return the ticket.
- `GET /__ccfb/tickets` → return current `state.json` (or empty list if absent).
- `GET /__ccfb/events` (SSE) → emit `{type:"tickets", tickets:[...]}` whenever `state.json` changes (fs.watch), and `{type:"reload"}` whenever a watched source file changes.
- `GET /__ccfb/widget.js` → serve the built widget.

**Binds to `127.0.0.1` only.**

## 6. Widget changes (in `feedback-widget.html`, the canonical source)

- **Transport layer:** a `submit(ticket)` seam. Standalone → store + clipboard (current). Connected → optimistic local card as `todo` + `POST /__ccfb/tickets`.
- **Status UI:** in connected mode, render a **status pill** per card and group cards under `Todo / In-progress / Done` headers within the existing list (lightweight; not a drag-drop kanban). The header badge counts open (`todo` + `in-progress`).
- **SSE subscription:** in connected mode, subscribe to `/__ccfb/events`; on `tickets` events reconcile card statuses/results; on `reload` events call `location.reload()`.
- **Re-anchoring on load (connected):** fetch tickets, and for each, re-find its `quote` within the `context`/`section` block and re-wrap the highlight. This is the same text-anchoring logic the "per-URL persistence" feature needs — built once, used by both.
  - A `strike` ticket that was applied means the text is gone → re-anchor legitimately fails → expected for `done`.
  - A `todo`/`in-progress` ticket that fails to re-anchor → shown with an "anchor lost" badge; the ticket remains usable.

## 7. Trigger + loop (`/cc-feedback` skill/command)

- **`start`:**
  1. Spawn `server.js` (`--root` or `--proxy`) in the background on a chosen port.
  2. Open the app URL in Chrome (widget auto-injected, connected to the server).
  3. Enter a listening loop.
- **Loop (~5s cadence):** read new `inbox.jsonl` lines → add to `state.json` as `todo`. For each `todo`:
  1. Set `in-progress` (write `state.json` → server → SSE → sidebar updates live).
  2. Locate the source: grep the `quote` across the served root, disambiguate with `section`/`context`/`page`.
  3. Apply the edit described by `note`.
  4. Set `done` with a `result` summary + `files` (source change → server fs.watch → `reload` SSE → page reloads → widget re-anchors).
  5. On failure: set `error` with a message.
- **`stop`:** kill the server, exit the loop.

## 8. Ticket lifecycle

```
(submitted) --POST--> todo --picked up--> in-progress --fix applied--> done
                                              |
                                              +--can't fix--> error --(user edits note)--> todo
```

## 9. Error handling

- Unfixable/ambiguous ticket → `error` + human-readable message on the card; the user edits the note, which re-submits it as a fresh `todo`.
- Re-anchor miss on a non-strike ticket → "anchor lost" badge; ticket stays in the list.
- Server process dies → the loop health-checks the port and surfaces the failure in the session.
- Malformed `inbox.jsonl` line → skipped and logged; never crashes the loop.

## 10. Security

- Server binds to `127.0.0.1` only; the widget script is served only from the companion server.
- Comment text is treated strictly as a **task description**, never as commands to execute. The loop edits source files the normal way and **never runs shell commands embedded in ticket text**. Git is the undo path.
- The page under review is the developer's own locally-served app, so the trust boundary is the developer's machine.

## 11. v1 scope (YAGNI) / non-goals

**In:** one app + one session + one browser; status pills + grouping; `--root` and `--proxy` modes; best-effort re-anchoring with orphan flagging; localhost, no auth.

**Out (later):** drag-drop kanban; multiple concurrent apps/sessions; auth/remote use; diff-approval gate (we chose auto-apply); analytics; threaded/replies on tickets.

## 12. Shared dependency

The connected-mode **re-anchoring** logic (find a saved `quote` within its `context` and re-wrap) is the same primitive the standalone **per-URL persistence** feature needs. Implement it once as a reusable function in the widget.
