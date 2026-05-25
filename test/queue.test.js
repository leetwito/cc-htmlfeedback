const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendTicket, readState, newTicket } = require('../lib/queue.js');

function tmpDir(){ return fs.mkdtempSync(path.join(os.tmpdir(), 'ccfb-')); }

test('newTicket fills id, status=todo, createdAt', () => {
  const t = newTicket({ note: 'make it blue', page: 'http://x/' });
  assert.ok(t.id && typeof t.id === 'string');
  assert.equal(t.status, 'todo');
  assert.ok(t.createdAt > 0);
  assert.equal(t.note, 'make it blue');
  assert.equal(t.type, 'comment');
});

test('newTicket honors strike type', () => {
  assert.equal(newTicket({ type: 'strike' }).type, 'strike');
});

test('appendTicket writes one JSONL line per call', () => {
  const dir = tmpDir();
  appendTicket(dir, newTicket({ note: 'a', page: 'p' }));
  appendTicket(dir, newTicket({ note: 'b', page: 'p' }));
  const lines = fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).note, 'a');
  assert.equal(JSON.parse(lines[1]).note, 'b');
});

test('readState returns empty tickets when state.json missing', () => {
  assert.deepEqual(readState(tmpDir()), { version: 1, tickets: [] });
});
