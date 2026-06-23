#!/usr/bin/env node
// Block until a NEW comment actually arrives on some page (any feedback_inbox.jsonl under
// <queueDir> GROWS — they are append-only), print a marker, and exit 0. On timeout, print
// nothing, exit 0. Lets the Claude session wait event-driven across all pages, then re-scan.
//   node lib/watch-inbox.js <queueDir> [timeoutMs]
//
// Robustness: we do NOT finish on the raw fs event. macOS recursive fs.watch delivers coarse
// /coalesced events — e.g. a sibling feedback_tasks.json board write reports as a change in
// the same dir — which previously caused spurious wakes (busy-loop risk). Instead every event
// re-tallies the total bytes of all inbox files and only finishes when that total INCREASED.
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2] || '.cc-htmlfeedback';
const timeoutMs = Number(process.argv[3] || 1800000);
const pagesDir = path.join(dir, 'pages');

let done = false, timer = null; const watchers = [];
function finish(changed){ if (done) return; done = true;
  if (changed) process.stdout.write(changed + '\n');
  for (const w of watchers) { try { w.close(); } catch {} } clearTimeout(timer); process.exit(0);
}

// Sum of bytes across every page's append-only feedback_inbox.jsonl. A real new comment can
// only make this strictly increase; board/index writes leave it unchanged.
function inboxBytes(){
  let total = 0, keys = [];
  try { keys = fs.readdirSync(pagesDir); } catch { return 0; }
  for (const k of keys) {
    try { total += fs.statSync(path.join(pagesDir, k, 'feedback_inbox.jsonl')).size; } catch {}
  }
  return total;
}
let baseline = inboxBytes();
function check(){ const n = inboxBytes(); if (n > baseline) finish('inbox-grew'); else if (n < baseline) baseline = n; }

try { fs.mkdirSync(pagesDir, { recursive: true }); } catch {}
try {
  // Recursive watch (macOS/Windows). Verify real growth on every event.
  watchers.push(fs.watch(dir, { recursive: true }, () => check()));
} catch {
  // Linux fallback: recursive fs.watch is unreliable. Watch pages/ (new page subdirs) plus
  // each existing page subdir; still gate on actual inbox growth.
  try { watchers.push(fs.watch(pagesDir, () => check())); } catch {}
  try { for (const k of fs.readdirSync(pagesDir)) watchers.push(fs.watch(path.join(pagesDir, k), () => check())); } catch {}
}
timer = setTimeout(() => finish(null), timeoutMs);
