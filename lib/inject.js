function injectWidget(html, sessionId, mode = 'static'){
  if (html.includes('src="/__ccfb/widget.js"')) return html; // idempotent — match the injected tag, not mere text mentions
  const tags =
    `<script>window.__CCFB={endpoint:"",sessionId:${JSON.stringify(sessionId)},mode:${JSON.stringify(mode)}};</script>` +
    `<script src="/__ccfb/widget.js"></script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tags + '</body>') : html + tags;  // case-insensitive </BODY>
}
module.exports = { injectWidget };
