// Ticket queue helpers — the file-on-disk contract between the Claude session and the browser.
// Two-file ownership: the SERVER appends new tickets to inbox.jsonl; the SESSION writes state.json.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const QUEUE_DIR = '.cc-htmlfeedback';
function inboxPath(dir){ return path.join(dir, 'inbox.jsonl'); }
function statePath(dir){ return path.join(dir, 'state.json'); }

function newTicket(fields){
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    type: fields.type === 'strike' ? 'strike' : 'comment',
    status: 'todo',
    quote: fields.quote || '',
    context: fields.context || '',
    section: fields.section || '',
    note: fields.note || '',
    page: fields.page || '',
    files: [],
    result: '',
    createdAt: now,
    updatedAt: now,
  };
}

function appendTicket(dir, ticket){
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(inboxPath(dir), JSON.stringify(ticket) + '\n');
}

function readState(dir){
  try { return JSON.parse(fs.readFileSync(statePath(dir), 'utf8')); }
  catch { return { version: 1, tickets: [] }; }
}

module.exports = { QUEUE_DIR, inboxPath, statePath, newTicket, appendTicket, readState };
