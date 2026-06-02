function injectWidget(html, sessionId, mode = 'static'){
  if (html.includes('/__ccfb/widget.js')) return html; // idempotent
  const tags =
    `<script>window.__CCFB={endpoint:"",sessionId:${JSON.stringify(sessionId)},mode:${JSON.stringify(mode)}};</script>` +
    `<script src="/__ccfb/widget.js"></script>`;
  return html.includes('</body>') ? html.replace('</body>', tags + '</body>') : html + tags;
}
module.exports = { injectWidget };
