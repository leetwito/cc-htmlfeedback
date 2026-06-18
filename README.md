# cc-htmlfeedback

A zero-dependency, in-page feedback tool. Highlight text on any page to leave comments and suggestions, then either copy the structured feedback or let Claude Code fix it live.

## Features

- **Highlight to comment.** Select text -> popover. `Enter` = comment, `Backspace` on an empty box = strikethrough. Select blank space to mark "something's missing here".
- **Structured side panel.** Every note captures its section heading, the quoted text, surrounding context, and your note. Dock it left/right; undo/redo with `cmd/ctrl+Z`.
- **One-click export.** Copy clean, structured feedback (with the page URL) to paste anywhere.
- **Live fixes with Claude Code.** Connect to a Claude Code session and your comments become a work queue: comment -> Claude edits the source -> the page updates in place, no reload.

## Install

The widget loads as a Chrome extension. That's the way to use it.

### Chrome extension
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the icon, then click it on any page to show/hide the widget.

> Chrome blocks injection on internal pages (`chrome://`, the Web Store, etc.) - that's a browser restriction.

### Try it first
Open `playground_file.html` in your browser and load the extension to play with every feature on a sample document.

## Live mode with Claude Code

Skip the copy-paste: comments become tickets that Claude Code applies and verifies for you. Run this in your project's Claude Code session:

```
/cc-htmlfeedback                          # serve the current dir on :4317
/cc-htmlfeedback http://localhost:5173    # or proxy your existing dev server (keeps HMR)
/cc-htmlfeedback stop                     # stop the loop + server
```

Highlight anything, write what you want changed, submit - then watch the ticket go `todo -> in-progress -> done` as Claude fixes it and verifies in a separate tab. Open several pages at once and they're fixed concurrently. Git is your undo.

## Build

`feedback-widget.html` is the single source of truth. After editing it, regenerate the four outputs:

```bash
npm run build     # regenerates extension/feedback-widget.js from the source
npm run check     # verify the output is in sync (no writes; non-zero on drift)
```

## License

MIT - see [LICENSE](LICENSE).
