const test = require('node:test');
const assert = require('node:assert');

test('wakes (exits) when ANY page inbox changes anywhere in the tree', async () => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfbw-'));
  const inbox = path.join(dir, 'pages', 'aaaaaaaaaaaa', 'feedback_inbox.jsonl');
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  const proc = spawn('node', [path.join(__dirname, '..', 'lib', 'watch-inbox.js'), dir, '10000']);
  let out = ''; proc.stdout.on('data', d => out += d);
  const exited = new Promise(r => proc.on('exit', r));
  // Append repeatedly until the watcher wakes. fs.watch attach latency is unbounded under load,
  // so a single append can land before the watch is armed and be missed forever; each later
  // append grows the inbox again and re-triggers the byte-growth check once the watch is up.
  let done = false; exited.then(() => { done = true; });
  for (let i = 0; i < 40 && !done; i++) {
    fs.appendFileSync(inbox, '{"id":"x' + i + '"}\n');
    await new Promise(r => setTimeout(r, 100));
  }
  const code = await exited;
  assert.equal(code, 0);
  // The watcher no longer prints the changed path — it prints a single 'inbox-grew' marker
  // and the session re-scans every page on wake. Assert the actual marker contract.
  assert.equal(out.trim(), 'inbox-grew');
});
