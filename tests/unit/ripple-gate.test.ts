// Rule: a Ripple apply the pre-commit gate refuses leaves the library as it was. The page
// file, the ruling log (and so the next hop's job), a minted page and its sidecar are all
// put back, nothing is left uncommitted, the refusal reaches the caller, and the card
// stays waiting. Real git, and the real gate.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Gate, GateRefused } from '../../src/hoard/git/gate.ts';
import { textconvCommand } from '../../src/hoard/git/blame.ts';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { ATTRIBUTES } from '../../src/hoard/git/start.ts';
import { MarkStore } from '../../src/hoard/marks/store.ts';
import { PageStore } from '../../src/hoard/pages/store.ts';
import { DEFAULT_BRIEF, Ripple } from '../../src/hoard/ripple/engine.ts';
import { ownerOf } from '../../src/hoard/review/owner.ts';
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
  const gate = new Gate({ library: () => lib.library, log });
  layer.useGate(gate);
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
  return { lib, layer, gate, store, marks, log, ripple, judged, status, read, warnings };
}

test('a claim the gate refuses leaves the page, the ruling log and the history as they were, and the card waiting', async (t) => {
  const { ripple, gate, judged, status, read, warnings } = await setup(t);
  const card = await judged([{ kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'The wall was rebuilt in stone' }]);
  const [page, rulings, head] = [read('wiki/Harbour.html'), read('.neo/ripple/rulings.jsonl'), await ripple.overview().proposals.length];
  assert.equal(await status(), '', 'a clean start');
  await assert.rejects(ripple.decide(card.id, 'apply'), /library check refused/);
  assert.equal(read('wiki/Harbour.html'), page, 'the page is as it was');
  assert.equal(read('.neo/ripple/rulings.jsonl'), rulings, 'no ruling and no next-hop job was logged');
  assert.equal(await status(), '', 'nothing is left uncommitted');
  assert.deepEqual([ripple.overview().proposals.length, ripple.overview().proposals[0]!.status], [head, 'proposed'], 'the card is waiting');
  assert.ok(warnings.some((w) => /refused/.test(w.message)), 'the refusal is logged');
  assert.deepEqual(gate.held(), [], 'the restored paths are no longer held out of the writer\'s commits');
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

test('a restore that cannot put a file back throws, and the paths stay held', async (t) => {
  const { lib, layer, gate, store, marks, log, status } = await setup(t);
  const faulty = {
    head: () => layer.head(), show: (c: string, r: string) => layer.show(c, r), changed: (a: string, b: string, u: string) => layer.changed(a, b, u),
    release: (paths: readonly string[]) => layer.release(paths),
    held: (paths: readonly string[]) => layer.held(paths),
    // after the gate refuses, something takes the page's place, so it cannot be written back
    around: async <T>(paths: readonly string[], apply: () => Promise<T>) => {
      try {
        return await layer.around(paths, apply);
      } catch (err) {
        if (err instanceof GateRefused) {
          const file = path.join(lib.library, 'wiki', 'Harbour.html');
          rmSync(file);
          mkdirSync(path.join(file, 'in'), { recursive: true });
          writeFileSync(path.join(file, 'in', 'x'), 'x');
        }
        throw err;
      }
    },
  };
  const ripple = new Ripple({ library: () => lib.library, pages: store, marks, ownerOf: (root, id) => ownerOf(root, id), layer: faulty, log });
  const asked = await ripple.ask({ page: 'wiki/Storm.html' });
  writeFileSync(ripple.overview().jobs.find((j) => j.id === asked.job)!.answer, [{ kind: 'preflight', brief_sha256: sha256(DEFAULT_BRIEF), echo: ECHO },
    { kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'The wall was rebuilt in stone' }].map((l) => JSON.stringify(l)).join('\n'));
  await ripple.run();
  await layer.commitNow('import-author');
  assert.equal(await status(), '');
  await assert.rejects(ripple.decide(ripple.overview().proposals[0]!.id, 'apply'), /could not put back wiki\/Harbour\.html/);
  assert.deepEqual(gate.held(), ['.neo/ripple/rulings.jsonl', 'wiki/Harbour.html'], 'nothing is released while a file is not back');
});

test('a page the gate still holds from an earlier refusal is not edited, and the card stays waiting', async (t) => {
  const { lib, layer, gate, ripple, judged, status, read, warnings } = await setup(t);
  const card = await judged([{ kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'The wall was rebuilt in stone' }]);
  // an earlier refused librarian edit left the page held (its words since put back)
  const original = read('wiki/Harbour.html')!;
  await assert.rejects(layer.around(['wiki/Harbour.html'], async () => { lib.write('wiki/Harbour.html', '<p data-block="a_1">Held words.</p>'); }));
  lib.write('wiki/Harbour.html', original); // the page as committed; the hold stays
  assert.deepEqual(gate.held(), ['wiki/Harbour.html']);
  const [page, rulings] = [read('wiki/Harbour.html'), read('.neo/ripple/rulings.jsonl')];
  await assert.rejects(ripple.decide(card.id, 'apply'), /still holds .*wiki\/Harbour\.html/);
  assert.equal(read('wiki/Harbour.html'), page, 'the held words are not touched');
  assert.equal(read('.neo/ripple/rulings.jsonl'), rulings);
  assert.deepEqual(gate.held(), ['wiki/Harbour.html'], 'the earlier hold is not freed');
  assert.equal(ripple.overview().proposals[0]!.status, 'proposed');
  assert.ok(warnings.some((w) => /still holds the page/.test(w.message)));
  assert.equal(await status(), '', 'nothing of this apply is left on disk');
});

// Rule: a Ripple apply that does not write never makes a librarian commit. A write refused
// as stale, or a mint whose page has appeared meanwhile, would otherwise reach the git
// layer as a failed edit, which commits the touched paths as the librarian's: the author's
// newer words would land in a librarian commit.
async function racing(t: { after(fn: () => void): void }, race: (lib: { library: string; write(rel: string, text: string): void }) => { write?: (id: string) => void; create?: () => void }) {
  const s = await setup(t);
  s.lib.write('wiki/Quay.html', '<p data-block="q1">The quay is made of timber.</p>');
  s.lib.write('.neo/pages/wiki/Quay.html.json', LORE);
  await s.layer.commitNow('import');
  const hooks = race(s.lib);
  const pages = {
    list: () => s.store.list(), read: (id: string) => s.store.read(id),
    write: async (id: string, before: string, after: string) => { hooks.write?.(id); return s.store.write(id, before, after); },
    create: async (tree: 'wiki' | 'sources', p: string, html: string) => { hooks.create?.(); return s.store.create(tree, p, html); },
  };
  const ripple = new Ripple({ library: () => s.lib.library, pages, marks: s.marks, ownerOf: (root, id) => ownerOf(root, id), layer: s.layer, log: s.log });
  const librarianCommits = async () => (await s.lib.git.run(s.lib.library, ['log', '--format=%an'])).stdout.split('\n').filter((a) => a === 'Librarian').length;
  const judge = async (lines: object[]) => {
    const asked = await ripple.ask({ page: 'wiki/Storm.html' });
    writeFileSync(ripple.overview().jobs.find((j) => j.id === asked.job)!.answer, [{ kind: 'preflight', brief_sha256: sha256(DEFAULT_BRIEF), echo: ECHO }, ...lines].map((l) => JSON.stringify(l)).join('\n'));
    await ripple.run();
    await s.layer.commitNow('import-author');
    return ripple.overview().proposals[0]!;
  };
  return { ...s, ripple, librarianCommits, judge };
}

test('a write refused as stale makes no librarian commit and leaves the author\'s newer words alone', async (t) => {
  const typed = '<p data-block="n1">The author typed this.</p>';
  const { ripple, judge, librarianCommits, read } = await racing(t, (l) => ({ write: (id) => { l.write(id, `${readFileSync(path.join(l.library, id), 'utf8')}${typed}`); } }));
  const card = await judge([{ kind: 'claim', target: 'Quay', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'The wall was rebuilt in stone' }]);
  const [commits, rulings] = [await librarianCommits(), read('.neo/ripple/rulings.jsonl')];
  await assert.rejects(ripple.decide(card.id, 'apply'), /changed while ripple was working/);
  assert.equal(await librarianCommits(), commits, 'no librarian commit');
  assert.match(read('wiki/Quay.html')!, /The author typed this\./, 'the author\'s words are still there');
  assert.equal(read('.neo/ripple/rulings.jsonl'), rulings);
  assert.equal(ripple.overview().proposals[0]!.status, 'proposed');
});

test('a mint whose page has appeared meanwhile makes no librarian commit and leaves that page alone', async (t) => {
  const { ripple, judge, librarianCommits, read } = await racing(t, (l) => ({ create: () => { l.write('wiki/Stone Wall.html', '<p data-block="w1">The author made this page.</p>'); l.write('.neo/pages/wiki/Stone Wall.html.json', LORE); } }));
  const card = await judge([{ kind: 'mint', title: 'Stone Wall', text: 'The wall.', reason: 'r', quote: 'The wall was rebuilt in stone' }]);
  const commits = await librarianCommits();
  const done = await ripple.decide(card.id, 'apply');
  assert.equal(done.proposal.status, 'deferred');
  assert.equal(await librarianCommits(), commits, 'no librarian commit');
  assert.equal(read('wiki/Stone Wall.html'), '<p data-block="w1">The author made this page.</p>');
  assert.equal(read('.neo/pages/wiki/Stone Wall.html.json'), LORE, 'the sidecar that came with it is left alone too');
});
