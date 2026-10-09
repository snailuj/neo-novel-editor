// The probe's main-process half, for scripts/plugins-main.test.js: echo
// answers with what it was sent, fail throws, and the host it was handed is
// kept, so a test can use it as a plugin would.

'use strict';

exports.host = null;

exports.activate = (host) => {
  exports.host = host;
  host.handle('echo', (payload) => payload);
  host.handle('fail', () => { throw new Error('failed on purpose'); });
};
