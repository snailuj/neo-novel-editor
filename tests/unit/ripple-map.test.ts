// The wiki map a ripple packet may carry: every page by folder, cut to a size by a trim
// ladder that says what it left out. Fixtures are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wikiMap } from '../../src/hoard/ripple/map.ts';
import { buildCorpus, linkHops, type Source } from '../../src/hoard/ripple/shortlist.ts';

// A chain of pages leading away from the hub, some side pages, and two no link reaches.
const notes: [string, string][] = [['Hub.md', 'The hub names [[Step-01]].\n']];
for (let i = 1; i <= 12; i++) {
  const next = i < 12 ? ` Then [[Step-${String(i + 1).padStart(2, '0')}]].` : '';
  notes.push([`${i % 3 ? 'lore' : 'places/coast'}/Step-${String(i).padStart(2, '0')}.md`, `---\naliases: [Stair ${i}, Rung ${i}]\n---\nStep ${i}.${next}\n`]);
}
notes.push(['lore/Side-Path.md', 'Off [[Step-03]].\n'], ['lore/Lone-Isle.md', 'Nobody links here.\n'], ['Far-Shore.md', '---\naliases: [Far]\n---\nAlone.\n']);
const corpus = buildCorpus(notes, ['']);
const hub: Source = { relpath: 'Hub.md', text: notes[0]![1] };
const size = corpus.docs.length - 1;

function listed(text: string): string[] {
  return text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(' ')[0]!);
}

test('the whole map lists every page but the source, grouped by folder, with aliases and link counts', () => {
  const m = wikiMap(corpus, 100_000, hub);
  assert.equal(m.rung, 1);
  assert.equal(m.hidden, 0);
  assert.equal(m.listed.length, size);
  assert.ok(!m.listed.includes('Hub.md'), 'the source is left out');
  assert.match(m.text, /^Rung 1 of 4/);
  assert.match(m.text, /^- Step-02 \(aka Rung 2, Stair 2\) \[2 links\]$/m);
  assert.match(m.text, /^- Lone-Isle \[0 links\]$/m);
  const folders = m.text.split('\n').filter((l) => l.endsWith('/'));
  assert.deepEqual(folders, ['/', 'lore/', 'places/coast/'], 'folders sorted, the root as /');
  const lore = m.text.slice(m.text.indexOf('lore/'), m.text.indexOf('places/coast/'));
  const titles = listed(lore);
  assert.deepEqual(titles, [...titles].sort(), 'titles sorted within a folder');
});

// Rule: whatever the size, the map fits it, and every page is listed or counted as not
// shown; a page nearer the source is never dropped while a farther one is kept.
test('the trim ladder fits any size, counts what it drops, and drops the farthest first', () => {
  const hops = linkHops(corpus, hub);
  const dist = (rel: string) => hops.get(rel) ?? Number.POSITIVE_INFINITY;
  const byName = new Map(corpus.docs.map((d) => [d.name, d.relpath]));
  const seen = new Set<number>();
  for (let max = 0; max <= 1600; max += 9) {
    const m = wikiMap(corpus, max, hub);
    seen.add(m.rung);
    assert.ok(m.text.length <= max, `fits ${max}`);
    assert.equal(m.listed.length + m.hidden, size, `every page counted at ${max}`);
    assert.deepEqual(listed(m.text).map((n) => byName.get(n)).sort(), [...m.listed].sort(), 'the text lists what it says it lists');
    if (m.hidden && m.text) assert.match(m.text, new RegExp(`^${m.hidden} pages not shown`, 'm'));
    if (m.rung >= 2) assert.ok(!m.text.includes('(aka'), 'rung 2 drops aliases');
    if (m.rung >= 3) assert.ok(!m.text.includes(' links]'), 'rung 3 drops link counts');
    const kept = new Set(m.listed);
    const dropped = corpus.docs.map((d) => d.relpath).filter((r) => r !== 'Hub.md' && !kept.has(r));
    if (m.listed.length && dropped.length) {
      assert.ok(Math.max(...m.listed.map(dist)) <= Math.min(...dropped.map(dist)), `nearest kept at ${max}`);
    }
  }
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4], 'baseline: every rung was reached');
});

test('a source absent from the corpus is measured from the pages its text links', () => {
  const absent: Source = { relpath: 'sources/New.md', text: 'It reaches [[Step-12]].' };
  const m = wikiMap(corpus, 260, absent);
  assert.ok(m.listed.length > 0 && m.hidden > 0, `baseline: the map is cut (${m.listed.length} listed)`);
  assert.equal(m.rung, 4);
  assert.ok(m.listed.includes('places/coast/Step-12.md'), 'the linked page is kept first');
  assert.equal(m.listed.length + m.hidden, corpus.docs.length);
});
