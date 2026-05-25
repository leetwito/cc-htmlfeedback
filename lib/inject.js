// Insert the cc-htmlfeedback widget into a served HTML document (connected mode).
function injectWidget(html, sessionId){
  if (html.includes('/__ccfb/widget.js')) return html; // idempotent
  const tags =
    `<script>window.__CCFB={endpoint:"",sessionId:${JSON.stringify(sessionId)}};</script>` +
    `<script src="/__ccfb/widget.js"></script>`;
  return html.includes('</body>')
    ? html.replace('</body>', tags + '</body>')
    : html + tags;
}
module.exports = { injectWidget };
