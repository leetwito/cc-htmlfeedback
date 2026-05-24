// cc-htmlfeedback — MV3 service worker.
// Click the toolbar icon: if the widget isn't on the page yet, inject it and open the panel;
// if it's already there, just toggle the panel. Uses activeTab (granted on click) — no broad host access.

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || /^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url || '')) {
    // Can't inject into browser-internal pages.
    return;
  }
  try {
    // Is the widget already present?
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (window.__fbWidget) { window.__fbWidget.toggle(); return true; }
        return false;
      }
    });
    if (probe && probe.result === true) return; // toggled an existing instance

    // Not present yet — inject the self-contained widget, then open its panel.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['feedback-widget.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { if (window.__fbWidget) window.__fbWidget.open(); }
    });
  } catch (e) {
    console.error('cc-htmlfeedback injection failed:', e);
  }
});
