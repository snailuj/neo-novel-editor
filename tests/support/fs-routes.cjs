'use strict';

// Reaches the modules that can write a file or start a program (fs, fs/promises, Electron's
// original-fs, child_process, worker_threads) by each route main-process code has, and aims
// what it finds at `outsideFile`. Run in the Electron main process by
// tests/e2e/isolation.spec.mjs. It is a file of its own because import() works only in a module
// the loader knows: the function the test hands to app.evaluate has none.
//
// Each case is [route, specifier]. The outcome of each is 'refused' (the route threw, or the
// guard did), 'written' (a file appeared outside: the guard was walked round) or 'failed: ...'
// (something else went wrong, which the test should not read as a refusal).

const fs = require('fs');

async function load(route, id) {
  if (route === 'require') return require(id);
  if (route === 'getBuiltinModule') return process.getBuiltinModule(id);
  if (route === 'import default') return (await import(id)).default;
  if (route === 'import named') return import(id);
  throw new Error(`no route called ${route}`);
}

// What to do with the module: a write, a program, or a thread that writes with its own fs.
async function act(loaded, id, target) {
  if (/child_process$/.test(id)) {
    loaded.execFileSync('neo-test-no-such-program');
  } else if (/worker_threads$/.test(id)) {
    const code = `require('fs').writeFileSync(${JSON.stringify(target)}, 'x')`;
    const worker = new loaded.Worker(code, { eval: true });
    await new Promise((resolve, reject) => { worker.on('exit', resolve); worker.on('error', reject); });
  } else if (id.endsWith('/promises')) {
    await loaded.writeFile(target, 'x');
  } else {
    loaded.writeFileSync(target, 'x');
  }
}

const refusal = (error) => error.code === 'TEST_WRITE_OUTSIDE_PROFILE' || /disabled in tests/.test(error.message);

async function tryRoutes(cases, outsideFile) {
  const outcomes = {};
  for (const [index, [route, id]] of cases.entries()) {
    // a file of its own for each case, so that one that wrote cannot be taken for the next
    const target = `${outsideFile}.${index}`;
    let failure = null;
    try {
      await act(await load(route, id), id, target);
    } catch (error) {
      failure = error;
    }
    let outcome;
    if (fs.existsSync(target)) outcome = 'written';
    else if (failure && refusal(failure)) outcome = 'refused';
    else outcome = `failed: ${failure ? failure.message : 'nothing refused it and nothing was written'}`;
    outcomes[`${route} ${id}`] = outcome;
  }
  return outcomes;
}

module.exports = { tryRoutes };
