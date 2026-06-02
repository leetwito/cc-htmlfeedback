const test = require('node:test');
const assert = require('node:assert');

test('wakes (exits) when ANY page inbox changes anywhere in the tree', async () => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfbw-'));
  fs.mkdirSync(path.join(dir, 'pages', 'aaaaaaaaaaaa'), { recursive: true });
  const proc = spawn('node', [path.join(__dirname, '..', 'lib', 'watch-inbox.js'), dir, '5000']);
  let out = ''; proc.stdout.on('data', d => out += d);
  await new Promise(r => setTimeout(r, 150));
  fs.appendFileSync(path.join(dir, 'pages', 'aaaaaaaaaaaa', 'feedback_inbox.jsonl'), '{"id":"x"}\n');
  const code = await new Promise(r => proc.on('exit', r));
  assert.equal(code, 0);
  assert.match(out, /aaaaaaaaaaaa/);
});
