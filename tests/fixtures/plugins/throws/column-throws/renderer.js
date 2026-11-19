// A plugin that takes the page column, opens it and then fails to activate: the host must take
// the column back with everything else the plugin added, for tests/e2e/split-column.spec.mjs.

'use strict';

NeoPlugins.register({
  id: 'column-throws',
  apiVersion: 6,
  activate(neo) {
    window.__columnThrows = 'ran';
    neo.column().open();
    throw new Error('failed on purpose');
  }
});
