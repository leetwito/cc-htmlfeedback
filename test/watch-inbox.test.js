const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'lib', 'watch-inbox.js');

test('prints new ticket lines when inbox grows past haveCount', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfb-w-'));
  const child = spawn(process.execPath, [SCRIPT, dir, '0', '5000']);
  let out = '';
  child.stdout.on('data', d => out += d);
  await new Promise(r => setTimeout(r, 200));
  fs.appendFileSync(path.join(dir, 'inbox.jsonl'), JSON.stringify({ id: 't1', note: 'hi' }) + '\n');
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0);
  assert.ok(out.includes('"t1"'), 'printed the new ticket line');
});

test('returns immediately (empty) on timeout when nothing new', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfb-w-'));
  fs.writeFileSync(path.join(dir, 'inbox.jsonl'), JSON.stringify({ id: 'old' }) + '\n');
  const start = Date.now();
  const child = spawn(process.execPath, [SCRIPT, dir, '1', '300']);
  let out = '';
  child.stdout.on('data', d => out += d);
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0);
  assert.equal(out.trim(), '', 'no output on timeout');
  assert.ok(Date.now() - start >= 250, 'waited for the timeout');
});
