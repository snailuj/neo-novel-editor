// A plugin written for API 5, one version before the page column: it writes down whether the
// host handed it a column(), for tests/e2e/split-column.spec.mjs.

'use strict';

window.__columnV5 = { activated: false, column: 'unset' };

NeoPlugins.register({
  id: 'column-v5',
  apiVersion: 5,
  activate(neo) {
    window.__columnV5 = { activated: true, column: typeof neo.column };
  }
});
