// The probe: a plugin that writes down everything the host tells it, for
// scripts/plugins.e2e.js to read back. It is written for API 2, so what it
// keeps as neo has where, go and replace too, for
// scripts/plugin-edits.e2e.js.

'use strict';

// said counts runs of the Say Hello command. When a test sets sayFails, the
// command calls it and returns its result, so the test can make the command
// throw or reject.
window.__probe = { activated: false, events: [], csp: [], neo: null, pane: null, said: 0, sayFails: null };
document.addEventListener('securitypolicyviolation', (e) => {
  window.__probe.csp.push(`${e.violatedDirective} ${e.blockedURI}`);
});

NeoPlugins.register({
  id: 'probe',
  apiVersion: 2,
  activate(neo) {
    window.__probe.activated = true;
    window.__probe.neo = neo;
    for (const name of ['book-open', 'book-close', 'chapter-change', 'chapter-saved', 'selection', 'rendered']) {
      neo.on(name, (detail) => window.__probe.events.push([name, detail]));
    }
    window.__probe.pane = neo.addPane({ id: 'pane', title: 'Probe Pane' });
    window.__probe.pane.element.textContent = 'What the probe shows.';
    neo.addCommand('hello', () => {
      window.__probe.said++;
      if (window.__probe.sayFails) return window.__probe.sayFails();
    });
    neo.status('Indexed');
  }
});
