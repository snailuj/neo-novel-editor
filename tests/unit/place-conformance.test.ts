import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import { validateHighlightV1, validatePlaceV1 } from '../../src/generated/validators.cjs';

// plugins.js is upstream's and carries its own plain place check (NeoPlugins.validPlace)
// and highlight check (the TypeErrors of highlight) rather than the generated
// validators. Each must give the same verdict as its schema.
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = path.join(root, 'tests', 'fixtures', 'places');

// plugins.js in a vm of its own: loading it touches nothing but window.NeoPlugins.
function hostCheck(): (place: unknown) => boolean {
  const context: Record<string, unknown> = {};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(path.join(root, 'plugins.js'), 'utf8'), context, { filename: 'plugins.js' });
  return (context.NeoPlugins as { validPlace: (place: unknown) => boolean }).validPlace;
}

type HighlightCall = (name: unknown, places: unknown) => void;

// plugins.js in a vm with one plugin, p, listed, written for API 2 and
// registered: whether the host takes a highlight call, as true, or throws a
// TypeError for it, as false. No book is open, so a call taken marks nothing.
function hostTakesHighlight(): (name: unknown, places: unknown) => boolean {
  const context: Record<string, unknown> = {
    neo: { plugins: [{ id: 'p', apiVersion: 2, rendererUrl: 'plugins/p/renderer.js', styleUrl: null }], logError() {} }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(path.join(root, 'plugins.js'), 'utf8'), context, { filename: 'plugins.js' });
  const handed: { highlight?: HighlightCall } = {};
  (context.NeoPlugins as { register: (plugin: unknown) => void }).register({
    id: 'p',
    apiVersion: 2,
    activate(neo: { highlight: HighlightCall }) { handed.highlight = neo.highlight; }
  });
  const highlight = handed.highlight;
  assert.ok(highlight, 'the plugin was handed highlight');
  return (name, places) => {
    try {
      highlight(name, places);
      return true;
    } catch (err) {
      // the vm's TypeError is not this realm's, so it is known by its name
      if ((err as Error).name === 'TypeError') return false;
      throw err;
    }
  };
}

function eachFixture(fn: (kind: string, name: string, place: unknown) => void): number {
  let seen = 0;
  for (const kind of ['valid', 'invalid']) {
    for (const name of readdirSync(path.join(fixtures, kind)).sort()) {
      fn(kind, name, JSON.parse(readFileSync(path.join(fixtures, kind, name), 'utf8')));
      seen++;
    }
  }
  return seen;
}

test('the host and the schema agree on every place fixture', () => {
  const validPlace = hostCheck();
  const seen = eachFixture((kind, name, place) => {
    const schema = validatePlaceV1(place);
    assert.equal(schema, kind === 'valid', `${kind}/${name}: the schema's verdict`);
    assert.equal(validPlace(place), schema, `${kind}/${name}: the host agrees with the schema`);
  });
  assert.ok(seen > 0, 'fixtures were found');
});

test('a highlight takes a name and places, each place as the place schema has it', () => {
  eachFixture((kind, name, place) => {
    assert.equal(validateHighlightV1({ name: 'claims', places: [place] }), kind === 'valid', `${kind}/${name}`);
  });
  assert.equal(validateHighlightV1({ name: 'claims', places: [] }), true, 'an empty list clears');
  for (const bad of ['Claims', 'a:b', '', '9lives', 'x'.repeat(33)]) {
    assert.equal(validateHighlightV1({ name: bad, places: [] }), false, bad);
  }
  assert.equal(validateHighlightV1({ name: 'claims' }), false, 'places are required');
});

test('the host and the schema agree on a highlight\'s name, its list and each place in it', () => {
  const hostTakes = hostTakesHighlight();
  const verdicts = new Set<boolean>();
  const agree = (name: unknown, places: unknown, what: string): void => {
    const schema = validateHighlightV1({ name, places });
    verdicts.add(schema);
    assert.equal(hostTakes(name, places), schema, what);
  };
  for (const name of ['claims', 'a', 'a-1', 'x'.repeat(32), 'Claims', 'a:b', 'a b', '', '9lives', '-a', 'x'.repeat(33), 7, null]) {
    agree(name, [], `name ${JSON.stringify(name)}`);
  }
  for (const places of [undefined, null, 'c1', {}, []]) agree('claims', places, `list ${JSON.stringify(places)}`);
  eachFixture((kind, file, place) => agree('claims', [place], `${kind}/${file} in a list`));
  assert.deepEqual([...verdicts].sort(), [false, true], 'both verdicts were reached');
});
