// A plugin written for API 2 that registers only when
// scripts/plugin-edits.e2e.js asks, with a book open. While it activates it
// highlights the places it is handed under two names, then waits; when the
// test calls window.__fleeting.fail() it fails, and the host disposes of it.

'use strict';

window.__fleeting = { neo: null, fail: null };
window.__registerFleeting = (places) => NeoPlugins.register({
  id: 'fleeting',
  apiVersion: 2,
  async activate(neo) {
    window.__fleeting.neo = neo;
    neo.highlight('one', places);
    neo.highlight('two', places);
    await new Promise((resolve) => { window.__fleeting.fail = resolve; });
    throw new Error('fleeting fails on purpose');
  }
});
