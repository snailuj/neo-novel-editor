// Rule: ripple never overwrites a paragraph the author last changed. On a librarian-owned
// wiki page where an author commit changed one paragraph, a claim on that paragraph
// becomes a suggestion mark and the file's bytes stay; a claim on a paragraph no author
// touched is written. The ripple here is built as the plugin builds it (ripple/wire.ts), so
// a blame that is not wired in shows as a write over the author's words.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { textconvCommand } from '../../src/hoard/git/blame.ts';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { ATTRIBUTES } from '../../src/hoard/git/start.ts';
import { MarkStore } from '../../src/hoard/marks/store.ts';
import { PageStore } from '../../src/hoard/pages/store.ts';
import { DEFAULT_BRIEF } from '../../src/hoard/ripple/engine.ts';
import { sha256 } from '../../src/hoard/ripple/rulings.ts';
import { makeRipple } from '../../src/hoard/ripple/wire.ts';
import { isolateGitConfig, tempDir, tempLibrary } from './git-support.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ECHO = 'When you are unsure, say nothing about the page: the writer would rather miss a ripple than undo a wrong one.';
const LORE = JSON.stringify({ version: 1, source: { path: '/v/x.md', name: 'x', sha256: 'a'.repeat(64) }, frontmatter: { type: 'lore' }, imported: '2026-11-01T12:00:00.000Z' });

test('a claim on a paragraph the author last changed is a suggestion; one on an untouched paragraph is written', async (t) => {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const attributesFile = path.join(tempDir(t), 'attributes');
  writeFileSync(attributesFile, `${ATTRIBUTES}\n`);
  const layer = new GitLayer({
    git: lib.git, library: lib.library, settings: resolveSettings({}, () => {}), attributesFile,
    textconv: textconvCommand(process.execPath, path.join(root, 'tools', 'git', 'neo-textconv.js')), log: () => {},
  });
  t.after(async () => { layer.stop(); await layer.drained(); });
  await layer.open();
  await layer.keepHistory();
  const store = new PageStore({ library: () => lib.library, layer, log: () => {} });
  const marks = new MarkStore({ library: () => lib.library, head: () => layer.head(), wrote: (n) => layer.wrote(n), log: () => {} });
  const ripple = makeRipple({ library: () => lib.library, log: () => {} }, layer, store, marks);

  const harbour = 'wiki/Harbour.html';
  lib.write(harbour, '<p data-block="a1">The harbour wall is made of timber.</p><p data-block="a2">Boats come in at high water.</p>');
  lib.write(`.neo/pages/${harbour}.json`, LORE);
  lib.write('wiki/Storm.html', '<p data-block="s1">The wall was rebuilt in stone. Boats now come in at dawn.</p>');
  lib.write('.neo/pages/wiki/Storm.html.json', LORE);
  await layer.commitNow('import'); // the librarian's page
  lib.write(harbour, '<p data-block="a1">The harbour wall is made of timber.</p><p data-block="a2">Boats come in at the tide.</p>');
  await layer.commitNow('import-author'); // the author's change to the second paragraph
  const before = readFileSync(path.join(lib.library, harbour), 'utf8');

  const asked = await ripple.ask({ page: 'wiki/Storm.html' });
  writeFileSync(ripple.overview().jobs.find((j) => j.id === asked.job)!.answer, [
    { kind: 'preflight', brief_sha256: sha256(DEFAULT_BRIEF), echo: ECHO },
    { kind: 'claim', target: 'Harbour', anchor: 'at the tide', text: 'at dawn', reason: 'r', quote: 'Boats now come in at dawn' },
    { kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'The wall was rebuilt in stone' },
  ].map((l) => JSON.stringify(l)).join('\n'));
  await ripple.run();
  const [onAuthors, onUntouched] = ripple.overview().proposals;

  const suggested = await ripple.decide(onAuthors!.id, 'apply');
  assert.equal(suggested.proposal.outcome, 'suggested');
  assert.equal(readFileSync(path.join(lib.library, harbour), 'utf8'), before, 'the author\'s paragraph is not written');
  assert.deepEqual((await marks.list(harbour)).map((m) => [m.kind, m.anchor.exact, m.proposed, m.created.who]), [['substitution', 'at the tide', 'at dawn', 'librarian']]);

  const written = await ripple.decide(onUntouched!.id, 'apply');
  assert.equal(written.proposal.outcome, 'written');
  assert.equal(readFileSync(path.join(lib.library, harbour), 'utf8'), before.replace('made of timber', 'rebuilt in stone'));
});
