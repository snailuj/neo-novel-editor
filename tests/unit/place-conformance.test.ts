import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import { validateHighlightV1, validatePlaceV1 } from '../../src/generated/validators.cjs';

// plugins.js is upstream's and carries its own plain place check (NeoPlugins.validPlace)
// rather than the generated validator. Both must give the same verdict on every fixture.
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
