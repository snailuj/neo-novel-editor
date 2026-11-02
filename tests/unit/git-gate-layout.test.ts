// Rule: frontmatter findings for a library page do not depend on HOARD_LAYOUT, the
// librarian CLI's vault layout, in which `sources/` is a different thing from a library's
// sources tree.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFiles } from '../../src/hoard/git/gate.ts';
import { LIBRARY_LAYOUT } from '../../src/hoard/git/layout.ts';
import { HOARD_LAYOUT } from '../../src/librarian/scheme.ts';

const page = (frontmatter: unknown) => JSON.stringify({
  version: 1,
  source: { path: '/vault/lore/Harbour.md', name: 'Harbour', sha256: 'a'.repeat(64) },
  frontmatter,
  imported: '2026-10-15T10:00:00Z',
});
const PAGE = '.neo/pages/wiki/Harbour.html.json';
const messages = () => checkFiles(
  [{ path: PAGE, text: page({ type: 'lore', colour: 'red' }) }],
  { schemeText: () => '{}' },
).map((f) => f.message);
const hoard = HOARD_LAYOUT as unknown as Record<string, unknown>;

test('Gate-Own-Layout: the library layout shares no folder list or name with the hoard vault layout', () => {
  for (const [k, v] of Object.entries(LIBRARY_LAYOUT)) assert.notEqual(v, hoard[k], `${k} is hoard's own`);
  assert.deepEqual(LIBRARY_LAYOUT.librarianDirs, ['wiki/', 'sources/']);
  for (const k of ['asIsDirs', 'skipDirs', 'authorBodyDirs', 'librarianAuthoredDirs', 'captureDirs', 'markDirs'] as const) {
    assert.deepEqual(LIBRARY_LAYOUT[k], [], `${k} holds a folder the library has no rule for`);
  }
});

test('Gate-Own-Layout: frontmatter findings for a library page do not change when HOARD_LAYOUT does', () => {
  const before = messages();
  assert.deepEqual(before, ["FM3 unknown key 'colour'", "FM10 'setting' required on lore (or the page is a 'subject')"]);
  const saved = Object.fromEntries(Object.entries(hoard).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, [...(v as string[])]]));
  try {
    // The arrays are mutable under the freeze: widen every zone to cover both trees.
    for (const k of Object.keys(saved)) (hoard[k] as string[]).splice(0, Infinity, 'wiki/', 'sources/', '');
    assert.deepEqual(messages(), before);
  } finally {
    for (const [k, v] of Object.entries(saved)) (hoard[k] as string[]).splice(0, Infinity, ...v);
  }
  assert.deepEqual(HOARD_LAYOUT.librarianDirs, saved['librarianDirs'], 'HOARD_LAYOUT was put back');
});
