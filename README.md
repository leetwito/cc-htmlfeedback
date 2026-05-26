# cc-htmlfeedback

A self-contained, dependency-free **in-page feedback tool**. Highlight any text on any page to leave **comments** (yellow highlight) or **strikethrough** suggestions, jot notes, then **copy structured feedback** (including the page URL) to hand back to whoever owns the page.

Built once, shipped four ways — all generated from a single source.

## Features
- Highlight any text → floating popover. **Enter** = comment, **Backspace** (empty box) = strike out.
- Select blank space to mark an **insertion point** ("something's missing here").
- Floating side panel (overlay, doesn't resize the page): each note shows its **section heading**, the **quoted text**, the **surrounding context**, an editable note, and a discard ✕.
- **Copy feedback** / quick-copy → plain text with the page URL. **cmd/ctrl+Z** undo, **cmd/ctrl+shift+Z** redo.
- Dock the panel left/right; move the popover left/right.
- Notes live in memory only — **copy before reloading**.

## Usage — four modes (all from one source)

| Mode | How |
|---|---|
| **Chrome extension** | Load `extension/` unpacked (see below). Click the toolbar icon on any page. |
| **Bookmarklet** | Open `dist/install-bookmarklet.html`, drag the button to your bookmarks bar, click it on any page. |
| **Drop-in script** | Copy `dist/feedback-widget.js` next to your page and add `<script src="feedback-widget.js"></script>`. |
| **Inline** | Paste the contents of `feedback-widget.html` just before `</body>` (fully self-contained, no external file). |

### Load the Chrome extension (unpacked)
1. Go to `chrome://extensions`.
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin **cc-htmlfeedback** and click its icon on any normal web page. Click again to toggle the panel.

(Browser-internal pages like `chrome://` can't be injected — that's a Chrome restriction.)

### Try it without installing
Open `test.html` (a sample document with varied headings, lists, tables, and styled text) in your browser and load the extension — or just paste the contents of `dist/feedback-widget.js` into the DevTools console on that page. It's the manual test fixture used to exercise every feature.

## Connected mode — live fixes with Claude Code

Standalone mode (above) is **export**: you copy structured feedback and paste it wherever. **Connected mode** removes the copy-paste — comments become a live work queue that your Claude Code session drains: comment → Claude edits the source → the page hot-reloads → a judge agent verifies → the ticket flips to **done**. The sidebar becomes a `todo / in-progress / done` board (one shared list across pages, persisted across sessions).

**Start it** in the Claude Code session for your project:

```
/cc-htmlfeedback                     # serve the current dir (static) on :4317
/cc-htmlfeedback http://localhost:5173   # or proxy your existing dev server (keeps its HMR)
/cc-htmlfeedback stop                # stop the loop + server
```

This starts the companion server (`server.js`), opens your app in Chrome with the widget injected and connected, and puts the session into a listening loop. Highlight anything, write what you want changed, submit — and watch the ticket go `todo → in-progress → done` as Claude applies and verifies the fix. Git is the undo path.

- **How it talks:** the widget POSTs each comment to the server, which appends it to `.cc-htmlfeedback/inbox.jsonl`. The session owns `.cc-htmlfeedback/state.json` (the board); the server relays state + reload events to the browser over SSE. (Both files are gitignored.)
- **The judge:** before any ticket is marked `done`, a separate agent opens the page in Chrome and independently verifies the change satisfies the comment and nothing broke — `pass` → done, `fail` → error with the reason.
- **Standalone still works:** with no server, the extension/bookmarklet behave exactly as before, and a dismissible banner offers a one-click prompt to start the live loop.

Run `node server.js --help`-style flags directly if you prefer: `--root <dir>`, `--proxy <url>`, `--port <n>`.

## Develop / build
`feedback-widget.html` is the **single source of truth** (style + markup + script). After editing it, regenerate everything:

```bash
node build.js          # or: npm run build
```

This writes `dist/feedback-widget.js`, `dist/feedback-bookmarklet.txt`, `dist/install-bookmarklet.html`, and syncs `extension/feedback-widget.js`. The bookmarklet is `'javascript:' + encodeURIComponent(feedback-widget.js)`.

To verify the four generated outputs are in sync with the source (e.g. in CI or a pre-commit hook):

```bash
node build.js --check   # or: npm run check — exits non-zero on drift, writes nothing
```

## Structure
```
feedback-widget.html      ← canonical source for the widget (edit this)
build.js                  ← regenerates dist/ + extension/feedback-widget.js (node build.js [--check])
package.json              ← npm run build / check / test / serve
test.html                 ← manual test fixture (sample document)
server.js                 ← connected-mode companion server (--root | --proxy, REST + SSE + file-watch)
lib/
  queue.js                  inbox.jsonl append / state.json read (the file contract)
  inject.js                 widget injection into served HTML
  watch-inbox.js            event-driven "block until a new ticket" for the loop
test/                     ← node:test suites (queue, inject, server, watch-inbox)
dist/
  feedback-widget.js        drop-in script
  feedback-bookmarklet.txt  javascript: URL
  install-bookmarklet.html  drag-to-install page
  favicon.png / favicon.ico
extension/
  manifest.json             MV3, activeTab + scripting (injects on toolbar click only)
  background.js             service worker: inject-or-toggle
  feedback-widget.js        synced from dist
  icons/                    icon.svg + icon16/48/128.png
.claude/skills/cc-htmlfeedback/
  SKILL.md                  the /cc-htmlfeedback loop (drain tickets → fix → reload → judge → done)
  judge-prompt.md           independent verification agent prompt
```

## Notes
- Engineering: namespaced `fb-*` CSS (no Shadow DOM — assumes non-hostile pages). Marks inherit host typography (font/spacing) but force a fixed dark text color so highlights stay legible even inside gradient/`background-clip:text` parents. The panel/popover sit at a very high `z-index` to clear common host overlays (cookie banners, chat widgets).
- Accessibility: the panel is an `aria-label`led region, the toast is an `aria-live` status, the notes list uses `list`/`listitem` roles, and icon-only buttons carry `aria-label`s. Note *creation* is still mouse-driven (select text → popover) — keyboard-triggered selection is a known gap.
- State lives in memory only — **Copy** is the export path, so copy before reloading. (Per-URL persistence is on the roadmap.)

## License
MIT — see [LICENSE](LICENSE).
