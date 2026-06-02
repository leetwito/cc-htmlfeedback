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
