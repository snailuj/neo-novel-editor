// A plugin that adds a listener and a pane and then throws while it
// activates. The host takes them away again and logs the error; NEO carries
// on.

'use strict';

window.__brokenHeard = 0;

NeoPlugins.register({
  id: 'broken',
  apiVersion: 1,
  activate(neo) {
    neo.on('chapter-saved', () => { window.__brokenHeard++; });
    neo.addPane({ id: 'pane', title: 'Broken Pane' });
    throw new Error('broken on purpose');
  }
});
