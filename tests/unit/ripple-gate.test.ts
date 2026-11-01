// Rule: a Ripple apply the pre-commit gate refuses leaves the library as it was. The page
// file, the ruling log (and so the next hop's job), a minted page and its sidecar are all
// put back, nothing is left uncommitted, the refusal reaches the caller, and the card
// stays waiting. Real git, and the real gate.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Gate } from '../../src/hoard/git/gate.ts';
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

async function setup(t: { after(fn: () => void): void }) {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const attributesFile = path.join(tempDir(t), 'attributes');
  writeFileSync(attributesFile, `${ATTRIBUTES}\n`);
  const warnings: { message: string; data?: unknown }[] = [];
  const log = (level: string, message: string, data?: unknown) => { if (level === 'warn' || level === 'error') warnings.push({ message, data }); };
  const layer = new GitLayer({
    git: lib.git, library: lib.library, settings: resolveSettings({}, () => {}), attributesFile,
    textconv: textconvCommand(process.execPath, path.join(root, 'tools', 'git', 'neo-textconv.js')), log: () => {},
  });
  layer.useGate(new Gate({ library: () => lib.library, log }));
  t.after(async () => { layer.stop(); await layer.drained(); });
  await layer.open();
  await layer.keepHistory();
  const store = new PageStore({ library: () => lib.library, layer, log: () => {} });
  const marks = new MarkStore({ library: () => lib.library, head: () => layer.head(), wrote: (n) => layer.wrote(n), log: () => {} });
  const ripple = makeRipple({ library: () => lib.library, log }, layer, store, marks);
  // a page the gate will refuse the librarian's edit of: its block id cannot be cited
  lib.write('wiki/Harbour.html', '<p data-block="a_1">The harbour wall is made of timber.</p>');
  lib.write('.neo/pages/wiki/Harbour.html.json', LORE);
  lib.write('wiki/Storm.html', '<p data-block="s1">The wall was rebuilt in stone.</p>');
  lib.write('.neo/pages/wiki/Storm.html.json', LORE);
  await layer.commitNow('import');
  const judged = async (lines: object[]) => {
    const asked = await ripple.ask({ page: 'wiki/Storm.html' });
    writeFileSync(ripple.overview().jobs.find((j) => j.id === asked.job)!.answer, [{ kind: 'preflight', brief_sha256: sha256(DEFAULT_BRIEF), echo: ECHO }, ...lines].map((l) => JSON.stringify(l)).join('\n'));
    await ripple.run();
    await layer.commitNow('import-author'); // ripple's own files, so what is left uncommitted afterwards is the apply's
    return ripple.overview().proposals[0]!;
  };
  const status = async () => (await lib.git.run(lib.library, ['status', '--porcelain'])).stdout;
  const read = (rel: string) => (existsSync(path.join(lib.library, rel)) ? readFileSync(path.join(lib.library, rel), 'utf8') : null);
  return { lib, layer, ripple, judged, status, read, warnings };
}

test('a claim the gate refuses leaves the page, the ruling log and the history as they were, and the card waiting', async (t) => {
  const { ripple, judged, status, read, warnings } = await setup(t);
  const card = await judged([{ kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'The wall was rebuilt in stone' }]);
  const [page, rulings, head] = [read('wiki/Harbour.html'), read('.neo/ripple/rulings.jsonl'), await ripple.overview().proposals.length];
  assert.equal(await status(), '', 'a clean start');
  await assert.rejects(ripple.decide(card.id, 'apply'), /library check refused/);
  assert.equal(read('wiki/Harbour.html'), page, 'the page is as it was');
  assert.equal(read('.neo/ripple/rulings.jsonl'), rulings, 'no ruling and no next-hop job was logged');
  assert.equal(await status(), '', 'nothing is left uncommitted');
  assert.deepEqual([ripple.overview().proposals.length, ripple.overview().proposals[0]!.status], [head, 'proposed'], 'the card is waiting');
  assert.ok(warnings.some((w) => /refused/.test(w.message)), 'the refusal is logged');
});

test('a mint the gate refuses leaves no page, no sidecar and no ruling', async (t) => {
  const { ripple, judged, status, read } = await setup(t);
  const card = await judged([{ kind: 'mint', title: 'Stone Wall', text: 'See [[Harbour#^nothere]].', reason: 'r', quote: 'The wall was rebuilt in stone' }]);
  const rulings = read('.neo/ripple/rulings.jsonl');
  await assert.rejects(ripple.decide(card.id, 'apply'), /library check refused/);
  assert.equal(read('wiki/Stone Wall.html'), null);
  assert.equal(read('.neo/pages/wiki/Stone Wall.html.json'), null);
  assert.equal(read('.neo/ripple/rulings.jsonl'), rulings);
  assert.equal(await status(), '');
  assert.equal(ripple.overview().proposals[0]!.status, 'proposed');
});
