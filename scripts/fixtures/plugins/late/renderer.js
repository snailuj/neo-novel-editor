// A plugin that registers only when scripts/plugins.e2e.js asks, once a book
// is open: what a plugin whose script arrives after the book opened sees.

'use strict';

window.__late = { events: [] };
window.__registerLate = () => NeoPlugins.register({
  id: 'late',
  apiVersion: 1,
  activate(neo) {
    neo.on('book-open', (detail) => window.__late.events.push(['book-open', detail]));
  }
});
