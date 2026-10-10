// A plugin that registers under another id than its plugin.json gives, with a
// stylesheet of its own. The host refuses it and takes the stylesheet away
// (scripts/plugins.e2e.js).

'use strict';

NeoPlugins.register({ id: 'some-other-id', apiVersion: 1, activate() {} });
