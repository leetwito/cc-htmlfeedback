# cc-htmlfeedback

This repo is the **runtime tooling** for the `cc-htmlfeedback` live-feedback loop:
`server.js` (serves the user's app with the feedback widget injected), `lib/` (inject, queue,
watch-inbox helpers), and `extension/feedback-widget.js` (the widget itself, built via `build.js`).

## The skill lives at USER level — not in this repo

The `/cc-htmlfeedback` skill was moved out of `.claude/skills/` here and now lives at:

```
~/.claude/skills/cc-htmlfeedback/
  ├── SKILL.md         ← canonical skill instructions
  └── judge-prompt.md  ← verification-judge prompt
```

**Maintain the skill there, directly.** Do not recreate a `.claude/skills/cc-htmlfeedback/`
copy in this repo — the user-level folder is the single source of truth. Edits to the skill's
behavior, arguments, or the judge prompt go into the user-level files.

### Why it's user-level

A user-level skill is invokable from **any** project, so you can run the feedback loop against
whatever web app you're working on — not only when your CWD is this repo.

### How the user-level skill reaches this repo's tooling

Because the skill is global, it launches the tooling by **absolute path** (the skill defines
`TOOLING = /Users/leetwito/PycharmProjects/cc-htmlfeedback`):

- `node $TOOLING/server.js --root <dir> --port <port>` (or `--proxy <url>`)
- `node $TOOLING/lib/watch-inbox.js <QUEUE> <lineCount> <timeoutMs>`

`server.js` resolves its own `./lib/*` and `extension/feedback-widget.js` relative to its file
location, so it runs correctly from any CWD. If you move or rename this repo, update the
`TOOLING` path in `~/.claude/skills/cc-htmlfeedback/SKILL.md`.
