import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// tests/support/main-loader.cjs is a copy of loadMain from scripts/power-loss.test.js, which
// upstream owns, and returns one extra member (`context`). When upstream changes the
// electron stub because main.js gained a call, the copy must change the same way: this
// fails until it does, instead of the kill tests breaking in a confusing way.

// core.autocrlf makes the working copy CRLF on Windows; compare on LF.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const upstream = read('../../scripts/power-loss.test.js');
const fork = read('../support/main-loader.cjs');

// The lines of `function loadMain() { ... }`, which ends at the first `}` in column 0.
function loadMainLines(source: string): string[] | undefined {
  return /^function loadMain\(\) \{\n[\s\S]*?\n\}$/m.exec(source)?.[0].split('\n');
}

// What differs between the two loaders once the fork's `context,` line is set aside, or
// undefined if they match.
function loaderDrift(upstreamSource: string, forkSource: string): string | undefined {
  const theirs = loadMainLines(upstreamSource);
  const ours = loadMainLines(forkSource);
  if (!theirs) return 'loadMain not found in scripts/power-loss.test.js';
  if (!ours) return 'loadMain not found in tests/support/main-loader.cjs';
  const kept = ours.filter((line) => line !== '    context,');
  if (kept.length !== ours.length - 1) return 'the fork loader must return `context,` exactly once';
  const at = theirs.findIndex((line, i) => line !== kept[i]);
  if (at === -1 && theirs.length === kept.length) return undefined;
  const i = at === -1 ? Math.min(theirs.length, kept.length) : at;
  return `loadMain differs at its line ${i + 1}: upstream ${JSON.stringify(theirs[i])}, fork ${JSON.stringify(kept[i])}`;
}

test('the fork loader matches the upstream one apart from the context line', () => {
  assert.equal(loaderDrift(upstream, fork), undefined);
});

test('the drift check can fail', () => {
  const changed = upstream.replace("getLocale: () => 'en'", "getLocale: () => 'fr'");
  assert.notEqual(changed, upstream, 'the upstream loader no longer has the line this test edits');
  assert.match(loaderDrift(changed, fork) ?? '', /getLocale/);

  assert.match(loaderDrift(upstream, fork.replace('    context,\n', '')) ?? '', /context/);
  assert.match(loaderDrift(upstream.replace('function loadMain() {', 'function load() {'), fork) ?? '', /loadMain/);
});
