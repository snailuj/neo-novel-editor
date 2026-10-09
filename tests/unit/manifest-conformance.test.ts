import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validatePluginManifestV1 } from '../../src/generated/validators.cjs';

// plugins-main.js is upstream's and carries its own plain manifest checks rather
// than the generated validator. Both must give the same verdict on every fixture.
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = path.join(root, 'tests', 'fixtures', 'manifests');
const { validManifest } = createRequire(import.meta.url)(path.join(root, 'plugins-main.js')) as {
  validManifest: (manifest: unknown) => boolean;
};

test('the host and the schema agree on every manifest fixture', () => {
  let seen = 0;
  for (const kind of ['valid', 'invalid']) {
    for (const name of readdirSync(path.join(fixtures, kind)).sort()) {
      const manifest: unknown = JSON.parse(readFileSync(path.join(fixtures, kind, name), 'utf8'));
      const schema = validatePluginManifestV1(manifest);
      assert.equal(schema, kind === 'valid', `${kind}/${name}: the schema's verdict`);
      assert.equal(validManifest(manifest), schema, `${kind}/${name}: the host agrees with the schema`);
      seen++;
    }
  }
  assert.ok(seen > 0, 'fixtures were found');
});
