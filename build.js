#!/usr/bin/env node
/* Build the distributable artifacts from the canonical source `feedback-widget.html`.
 *   node build.js          — regenerate all outputs
 *   node build.js --check  — verify on-disk outputs match source; exit 1 on drift, write nothing
 * Outputs:
 *   dist/feedback-widget.js        — standalone, self-injecting (drop-in <script>)
 *   dist/feedback-bookmarklet.txt  — javascript: URL (inlined, no hosting needed)
 *   dist/install-bookmarklet.html  — drag-to-bookmarks-bar installer
 *   extension/feedback-widget.js   — synced copy used by the Chrome extension
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

const js = `/*! feedback-widget.js — standalone, self-injecting in-page feedback tool.
 * Usage (pages you author):   <script src="feedback-widget.js"></script>
 *   ...or paste this whole file inside a <script> tag, or use the bookmarklet / extension build.
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

const bm = 'javascript:' + encodeURIComponent(js);

const install = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="favicon.png"><title>Install the Feedback bookmarklet</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.65;color:#1a1a2e}
a.bm{display:inline-block;background:#103a8e;color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-weight:700;box-shadow:0 4px 14px rgba(20,20,40,.18)}
ol{padding-left:20px}</style></head><body>
<h1>Feedback tool — bookmarklet</h1>
<ol><li><b>Show your bookmarks bar</b> (Cmd/Ctrl+Shift+B).</li><li><b>Drag this button onto it:</b></li></ol>
<p><a class="bm" href="${bm.replace(/"/g, '&quot;')}">📝 Feedback</a></p>
<p>Then open <b>any</b> web page and click the bookmark — the feedback tool appears top-right. Highlight text to comment/strike; <b>Copy feedback</b> exports all notes (including the page URL).</p>
<p style="color:#5b6072;font-size:14px">Notes live in memory only and clear on reload — copy before leaving the page.</p>
</body></html>`;

// All outputs are pure functions of the source — compute first, then write atomically.
const outputs = [
  ['dist/feedback-widget.js', js],
  ['extension/feedback-widget.js', js],
  ['dist/feedback-bookmarklet.txt', bm],
  ['dist/install-bookmarklet.html', install],
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
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
try {
  for (const [rel, content] of outputs) fs.writeFileSync(path.join(root, rel), content);
} catch (e) {
  fail('failed writing outputs (partial build may remain): ' + e.message);
}

console.log('Built dist/feedback-widget.js (' + js.length + 'B), dist/feedback-bookmarklet.txt (' + bm.length + 'B), dist/install-bookmarklet.html, extension/feedback-widget.js');
