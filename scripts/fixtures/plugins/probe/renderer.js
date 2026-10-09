// The probe: a plugin that writes down everything the host tells it, for
// scripts/plugins.e2e.js to read back.

'use strict';

window.__probe = { activated: false, events: [], csp: [], neo: null };
document.addEventListener('securitypolicyviolation', (e) => {
  window.__probe.csp.push(`${e.violatedDirective} ${e.blockedURI}`);
});

NeoPlugins.register({
  id: 'probe',
  apiVersion: 1,
  activate(neo) {
    window.__probe.activated = true;
    window.__probe.neo = neo;
    for (const name of ['book-open', 'book-close', 'chapter-change', 'chapter-saved', 'selection', 'rendered']) {
      neo.on(name, (detail) => window.__probe.events.push([name, detail]));
    }
  }
});
