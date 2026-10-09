// A plugin written for API 1, which adds nothing to NEO: it keeps what it was
// handed, for scripts/plugin-edits.e2e.js to see that API 2's calls are not
// among them.

'use strict';

window.__oldApi = { activated: false, neo: null };

NeoPlugins.register({
  id: 'old-api',
  apiVersion: 1,
  activate(neo) {
    window.__oldApi.activated = true;
    window.__oldApi.neo = neo;
  }
});
