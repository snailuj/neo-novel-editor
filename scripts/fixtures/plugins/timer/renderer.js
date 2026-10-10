// A plugin with callbacks of its own that run later, from a timer, and fail
// there, outside every call the host makes (scripts/plugins.e2e.js). The
// test asks for them by name; each schedules `times` runs.

'use strict';

NeoPlugins.register({
  id: 'timer',
  apiVersion: 1,
  activate(neo) {
    // the host throws a TypeError for a status that is not a string, from
    // inside its own file, in answer to this callback's call
    window.__timerBadStatus = (times = 1) => {
      for (let i = 0; i < times; i++) setTimeout(() => neo.status(42), 0);
    };
    // this script's own error
    window.__timerThrows = (times = 1) => {
      for (let i = 0; i < times; i++) setTimeout(() => { throw new Error('a timer throws on purpose'); }, 0);
    };
  }
});
