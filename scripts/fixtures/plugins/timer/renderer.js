// A plugin with callbacks of its own that run later, from a timer, and fail
// there, outside every call the host makes (scripts/plugins.e2e.js). The
// test asks for them by name; each schedules `times` runs, and window.__timerRuns
// counts those that have run.

'use strict';

window.__timerRuns = 0;

NeoPlugins.register({
  id: 'timer',
  apiVersion: 1,
  activate(neo) {
    // the host throws a TypeError for a status that is not a string, from
    // inside its own file, in answer to this callback's call
    window.__timerBadStatus = (times = 1) => {
      for (let i = 0; i < times; i++) setTimeout(() => { window.__timerRuns++; neo.status(42); }, 0);
    };
    // an invoke whose promise is dropped, as in a listener that does not
    // await it: this plugin has no main half, so each is refused. The
    // promise dropped is the one after finally, which counts the refusal.
    window.__timerInvoke = (times = 1) => {
      for (let i = 0; i < times; i++) setTimeout(() => { neo.invoke('index', i).finally(() => { window.__timerRuns++; }); }, 0);
    };
    // this script's own error
    window.__timerThrows = (times = 1) => {
      for (let i = 0; i < times; i++) setTimeout(() => { window.__timerRuns++; throw new Error('a timer throws on purpose'); }, 0);
    };
  }
});
