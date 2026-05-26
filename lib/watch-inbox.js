#!/usr/bin/env node
// Block until inbox.jsonl has more than <haveCount> lines (i.e. a new ticket arrived),
// then print the NEW ticket lines (one JSON object per line) and exit 0.
// On timeout (default 60s) print nothing and exit 0 — so the loop can re-check a stop
// condition and call this again. This lets the Claude session wait event-driven, not busy-poll.
//
//   node lib/watch-inbox.js <queueDir> <haveCount> [timeoutMs]
const fs = require('node:fs');
const { inboxPath } = require('./queue.js');

const dir = process.argv[2] || '.cc-htmlfeedback';
const have = Number(process.argv[3] || 0);
const timeoutMs = Number(process.argv[4] || 60000);
const file = inboxPath(dir);

function lines(){ try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } }
function emitNew(){
  const all = lines();
  if (all.length > have){ process.stdout.write(all.slice(have).join('\n') + '\n'); return true; }
  return false;
}

let done = false, watcher = null, timer = null;
function finish(){ if (done) return; done = true; try { watcher && watcher.close(); } catch {} clearTimeout(timer); process.exit(0); }

if (emitNew()) process.exit(0);
try {
  fs.mkdirSync(dir, { recursive: true });
  watcher = fs.watch(dir, (_e, f) => { if (f === 'inbox.jsonl' && emitNew()) finish(); });
} catch {}
timer = setTimeout(finish, timeoutMs);
