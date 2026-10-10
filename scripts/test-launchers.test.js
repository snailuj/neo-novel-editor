// Every program that starts NEO's main.js for a test must keep the windows hidden (see
// hideWindows in isolate-test-app.js). A launcher added later that skips it would put a window
// on the screen of whoever is working while the suites run.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const launchers = [
  ...fs.readdirSync(__dirname).filter((name) => name.endsWith('.e2e.js')).map((name) => path.join('scripts', name)),
  path.join('tests', 'support', 'electron-main.cjs')
];

test('there are launchers to check', () => {
  assert.ok(launchers.length >= 6, launchers.join(', '));
});

for (const launcher of launchers) {
  test(`${launcher} hides its windows before it loads main.js`, () => {
    const source = fs.readFileSync(path.join(root, launcher), 'utf8');
    const main = source.search(/require\(['"]\.\.\/(\.\.\/)?main\.js['"]\)/);
    assert.ok(main >= 0, 'loads main.js');
    const hides = source.search(/\bisolate\(|\bhideWindows\(/);
    assert.ok(hides >= 0 && hides < main, 'calls isolate() or hideWindows() before main.js');
  });
}
