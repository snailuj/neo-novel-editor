// A plugin that adds a left-pane tab and then fails to activate: the host must take the tab away
// again (tests/e2e/nav-tabs.spec.mjs).

'use strict';

window.__navThrows = 'unset';

NeoPlugins.register({
  id: 'navtab-throws',
  apiVersion: 6,
  activate(neo) {
    neo.addPane({ id: 'doomed', title: 'Doomed', nav: true });
    window.__navThrows = 'ran';
    throw new Error('this plugin fails on purpose');
  }
});
