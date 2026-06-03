// cc-htmlfeedback — MV3 service worker.
// Click the toolbar icon to SHOW/HIDE the whole widget on the page:
//   - not injected yet → inject the self-contained widget and show it (panel open);
//   - already present → toggle the entire widget's visibility (hide all chrome / show it again).
// Uses activeTab (granted on click) — no broad host access.

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || /^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url || '')) {
    // Can't inject into browser-internal pages.
    return;
  }
  try {
    // Already present? Toggle the whole widget's visibility.
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (window.__fbWidget) { window.__fbWidget.toggleVisible(); return true; }
        return false;
      }
    });
    if (probe && probe.result === true) return; // toggled visibility of an existing instance

    // Not present yet — inject the self-contained widget, show it, and open its panel.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['feedback-widget.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { if (window.__fbWidget) { window.__fbWidget.show(); window.__fbWidget.open(); } }
    });
  } catch (e) {
    console.error('cc-htmlfeedback injection failed:', e);
  }
});
