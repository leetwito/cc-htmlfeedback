#!/usr/bin/env node
/* Build the Chrome-extension widget from the canonical source `feedback-widget.html`.
 *   node build.js          — regenerate the output
 *   node build.js --check  — verify the on-disk output matches source; exit 1 on drift, write nothing
 * Output:
 *   extension/feedback-widget.js   — self-injecting widget used by the Chrome extension
 *                                    (also the copy server.js injects in live mode)
 */
const fs = require('fs');
const path = require('path');
const root = __dirname;
const check = process.argv.includes('--check');
const src = fs.readFileSync(path.join(root, 'feedback-widget.html'), 'utf8');

function fail(msg){ console.error('build.js: ' + msg); process.exit(1); }
function extract(re, label){
  const m = src.match(re);
  if (!m) fail('could not find ' + label + ' in feedback-widget.html (expected ' + re + ')');
  return m[1];
}
const countOf = re => (src.match(re) || []).length;

// Structural invariants the positional extraction below silently relies on.
if (countOf(/<style>/g) !== 1) fail('expected exactly one <style> block, found ' + countOf(/<style>/g));
if (countOf(/<script>/g) !== 1) fail('expected exactly one <script> block, found ' + countOf(/<script>/g));

const css = extract(/<style>([\s\S]*?)<\/style>/, '<style> block').trim();
const markup = extract(/<\/style>([\s\S]*?)<script>/, 'markup between </style> and <script>').trim().replace(/^<!--[\s\S]*?-->\s*/, '');
const scriptFull = extract(/<script>([\s\S]*?)<\/script>/, '<script> block').trim();
const m = scriptFull.match(/^\(function\(\)\{([\s\S]*)\}\)\(\);?$/);
if (!m) fail('source <script> must be a single bare IIFE: (function(){ ... })() — wrapper not found');
const body = m[1];
if (css.length < 100 || markup.length < 100 || body.length < 100) {
  fail('extraction produced suspiciously small output (css ' + css.length + ', markup ' + markup.length + ', body ' + body.length + ') — check the source structure');
}
const esc = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const js = `/*! feedback-widget.js — self-injecting in-page feedback tool, loaded by the Chrome extension.
 * No dependencies. Anchors to document.body so the whole page is annotatable.
 * Notes live in memory only — use "Copy feedback" / quick-copy to export (includes the file path).
 * GENERATED from feedback-widget.html by build.js — edit the .html, then re-run build.js.
 */
(function(){
  if (window.__fbWidgetLoaded || document.getElementById('fb-launch')) return;
  window.__fbWidgetLoaded = true;
  var FB_CSS = \`${esc(css)}\`;
  var FB_MARKUP = \`${esc(markup)}\`;
  function fbInit(){
    if (document.getElementById('fb-launch')) return;
    var st = document.createElement('style'); st.textContent = FB_CSS; document.head.appendChild(st);
    var tpl = document.createElement('template'); tpl.innerHTML = FB_MARKUP; document.body.appendChild(tpl.content);
${body}
  }
  if (document.body) fbInit();
  else document.addEventListener('DOMContentLoaded', fbInit);
})();
`;

// The output is a pure function of the source — compute first, then write atomically.
const outputs = [
  ['extension/feedback-widget.js', js],
];

if (check) {
  let drift = 0;
  for (const [rel, content] of outputs) {
    const p = path.join(root, rel);
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (cur !== content) { console.error('DRIFT: ' + rel + (cur === null ? ' (missing)' : ' (out of sync with feedback-widget.html)')); drift++; }
  }
  if (drift) fail(drift + ' file(s) out of sync — run `node build.js`');
  console.log('build.js --check: all ' + outputs.length + ' outputs in sync with feedback-widget.html');
  process.exit(0);
}

// The extension dir is hand-maintained (manifest.json, icons) — never auto-create it.
if (!fs.existsSync(path.join(root, 'extension'))) fail('extension/ directory not found — expected a hand-maintained dir with manifest.json');
try {
  for (const [rel, content] of outputs) fs.writeFileSync(path.join(root, rel), content);
} catch (e) {
  fail('failed writing output (partial build may remain): ' + e.message);
}

console.log('Built extension/feedback-widget.js (' + js.length + 'B)');
