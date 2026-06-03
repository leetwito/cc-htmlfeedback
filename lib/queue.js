// Ticket queue helpers — the file-on-disk contract between the Claude session and the browser.
// Per-page, two-file ownership: the SERVER appends to each page's feedback_inbox.jsonl;
// the SESSION is the sole writer of each page's feedback_tasks.json.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const QUEUE_DIR = '.cc-htmlfeedback';

// Key off the URL pathname (root-relative file) so boards survive a port change.
function fileOf(pageUrl){
  try { const u = new URL(pageUrl); let p = decodeURIComponent(u.pathname || '/'); if (p.endsWith('/')) p += 'index.html'; return p; }
  catch { return pageUrl || '/'; }
}
function pageKey(pageUrl){ return crypto.createHash('sha1').update(fileOf(pageUrl)).digest('hex').slice(0, 12); }

function pageDir(dir, key){ return path.join(dir, 'pages', key); }
function inboxPath(dir, key){ return path.join(pageDir(dir, key), 'feedback_inbox.jsonl'); }
function tasksPath(dir, key){ return path.join(pageDir(dir, key), 'feedback_tasks.json'); }
function indexPath(dir){ return path.join(dir, 'index.json'); }

function newTicket(fields){
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    type: fields.type === 'strike' ? 'strike' : 'comment',
    status: 'todo',
    quote: fields.quote || '', context: fields.context || '', section: fields.section || '',
    note: fields.note || '', page: fields.page || '',
    files: [], result: '', createdAt: now, updatedAt: now,
  };
}

function appendTicket(dir, key, ticket){
  fs.mkdirSync(pageDir(dir, key), { recursive: true });
  fs.appendFileSync(inboxPath(dir, key), JSON.stringify(ticket) + '\n');
}

function readTasks(dir, key){
  try { return JSON.parse(fs.readFileSync(tasksPath(dir, key), 'utf8')); }
  catch { return { version: 1, page: '', file: '', tickets: [] }; }
}

function readIndex(dir){
  try { return JSON.parse(fs.readFileSync(indexPath(dir), 'utf8')); } catch { return {}; }
}
// Read-modify-write with no lock: two concurrent first-time POSTs for different pages could
// lose one index entry (cosmetic only — each page's inbox/tasks files are written independently).
function upsertIndex(dir, key, page){
  const idx = readIndex(dir);
  if (!idx[key]) { idx[key] = { page, file: fileOf(page), firstSeen: Date.now() };
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(indexPath(dir), JSON.stringify(idx, null, 2)); }
  return idx[key];
}
function listPageKeys(dir){
  try { return fs.readdirSync(path.join(dir, 'pages')).filter(n => /^[0-9a-f]{12}$/.test(n)); }
  catch { return []; }
}

module.exports = { QUEUE_DIR, fileOf, pageKey, pageDir, inboxPath, tasksPath, indexPath,
  newTicket, appendTicket, readTasks, readIndex, upsertIndex, listPageKeys };
