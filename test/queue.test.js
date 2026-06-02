const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendTicket, newTicket, pageKey, inboxPath, tasksPath, indexPath, readTasks, listPageKeys } = require('../lib/queue.js');

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
  const k = pageKey('http://127.0.0.1:4321/p.html');
  appendTicket(dir, k, newTicket({ note: 'a', page: 'p' }));
  appendTicket(dir, k, newTicket({ note: 'b', page: 'p' }));
  const lines = fs.readFileSync(inboxPath(dir, k), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).note, 'a');
  assert.equal(JSON.parse(lines[1]).note, 'b');
});

test('readTasks returns empty board when tasks file missing', () => {
  assert.deepEqual(readTasks(tmpDir(), 'deadbeef0000'), { version: 1, page: '', file: '', tickets: [] });
});

test('pageKey is stable per pathname and ignores origin/port', () => {
  const a = pageKey('http://127.0.0.1:4321/foo/bar.html');
  const b = pageKey('http://127.0.0.1:9999/foo/bar.html');
  assert.equal(a, b);
  assert.notEqual(a, pageKey('http://127.0.0.1:4321/other.html'));
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('per-page paths nest under pages/<key>/', () => {
  const k = pageKey('http://x/p.html');
  assert.ok(inboxPath('/q', k).endsWith(path.join('pages', k, 'feedback_inbox.jsonl')));
  assert.ok(tasksPath('/q', k).endsWith(path.join('pages', k, 'feedback_tasks.json')));
  assert.ok(indexPath('/q').endsWith('index.json'));
});

test('readTasks returns an empty board when missing; listPageKeys scans pages/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfbq-'));
  assert.deepEqual(readTasks(dir, 'deadbeef0000'), { version: 1, page: '', file: '', tickets: [] });
  fs.mkdirSync(path.join(dir, 'pages', 'aaaaaaaaaaaa'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pages', 'bbbbbbbbbbbb'), { recursive: true });
  assert.deepEqual(listPageKeys(dir).sort(), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
});
