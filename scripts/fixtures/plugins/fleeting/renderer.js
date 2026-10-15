// A plugin written for API 3 that registers only when
// scripts/plugin-edits.e2e.js asks, with a book open. While it activates it
// highlights the places it is handed under two names and holds their
// chapters, then waits; when the test calls window.__fleeting.fail() it
// fails, and the host disposes of it.

'use strict';

window.__fleeting = { neo: null, fail: null };
window.__registerFleeting = (places) => NeoPlugins.register({
  id: 'fleeting',
  apiVersion: 3,
  async activate(neo) {
    window.__fleeting.neo = neo;
    neo.highlight('one', places);
    neo.highlight('two', places);
    neo.hold([...new Set(places.map((place) => place.chId))]);
    await new Promise((resolve) => { window.__fleeting.fail = resolve; });
    throw new Error('fleeting fails on purpose');
  }
});
