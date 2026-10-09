// A plugin that adds a listener, a pane and a command and then throws while
// it activates. The host takes them away again and logs the error; NEO
// carries on.

'use strict';

window.__brokenHeard = 0;
window.__brokenFixed = 0;

NeoPlugins.register({
  id: 'broken',
  apiVersion: 1,
  activate(neo) {
    neo.on('chapter-saved', () => { window.__brokenHeard++; });
    neo.addPane({ id: 'pane', title: 'Broken Pane' });
    neo.addCommand('fix', () => { window.__brokenFixed++; });
    throw new Error('broken on purpose');
  }
});
