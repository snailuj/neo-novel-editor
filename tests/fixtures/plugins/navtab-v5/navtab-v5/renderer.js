// A plugin written for API 5, one version before nav tabs: it asks for one and writes down what
// the host answered, for tests/e2e/nav-tabs.spec.mjs.

'use strict';

window.__navV5 = { error: null };

NeoPlugins.register({
  id: 'navtab-v5',
  apiVersion: 5,
  activate(neo) {
    try {
      neo.addPane({ id: 'pages', title: 'Pages', nav: true });
    } catch (err) {
      window.__navV5.error = `${err.name}: ${err.message}`;
    }
  }
});
