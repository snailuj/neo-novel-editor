// Rule: a client that replays `changes` from any seq it has seen, at any page size, ends
// with the same files and versions the server holds.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempHoard } from './hoard.ts';
import { startServer, type Client } from './support.ts';

type View = Map<string, string>;

const blob = (bytes: Buffer) => execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { input: bytes }).toString().trim();

/** Applies `changes` pages from `since` to `view`, the way a client catches up. */
async function replay(client: Client, view: View, since: number, limit: number): Promise<View> {
  const out = new Map(view);
  for (let pages = 0; pages < 10_000; pages += 1) {
    const { json } = await client.changes(since, limit);
    for (const c of json.changes as Array<{ path: string; version: string | null }>) {
      if (c.version === null) out.delete(c.path); else out.set(c.path, c.version);
    }
    if (!json.more) return out;
    assert.ok(json.seq > since, 'a page that says more must advance the seq');
    since = json.seq;
  }
  return assert.fail('replay did not finish');
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function listDisk(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? listDisk(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}

test('replaying changes from any snapshot at any page size reproduces the server tree', async (t) => {
  const h = tempHoard(t);
  const { client } = await startServer(t, h);
  const view: View = new Map();
  const snapshots: Array<{ seq: number; view: View }> = [];
  const tally = { create: 0, update: 0, delete: 0, move: 0, caseMove: 0, rejected: 0 };
  let counter = 0;
  const text = () => `<p>${(counter += 1)}</p>\r\n`;

  const snap = (seq: number) => snapshots.push({ seq, view: new Map(view) });
  const create = async (p: string) => {
    const r = await client.put(p, text(), { 'If-None-Match': '*' });
    if (r.status !== 200) { tally.rejected += 1; return; }
    view.set(p, r.json.version); tally.create += 1; snap(r.json.seq);
  };
  const update = async (p: string) => {
    const r = await client.put(p, text(), { 'If-Match': `"${view.get(p)}"` });
    assert.equal(r.status, 200);
    view.set(p, r.json.version); tally.update += 1; snap(r.json.seq);
  };
  const del = async (p: string) => {
    const r = await client.del(p, view.get(p));
    assert.equal(r.status, 200);
    view.delete(p); tally.delete += 1; snap(r.json.seq);
  };
  const move = async (from: string, to: string) => {
    const r = await client.move(from, to, view.get(from));
    if (r.status !== 200) { tally.rejected += 1; return; }
    view.delete(from); view.set(to, r.json.version);
    if (from.toLowerCase() === to.toLowerCase()) tally.caseMove += 1; else tally.move += 1;
    snap(r.json.seq);
  };

  // A scripted run first, so the property is checked on a known mix even if the random run changes.
  for (const p of ['book-1/chapters/one.html', 'book-1/chapters/two.html', 'wiki/place.html', 'library.json']) await create(p);
  await update('wiki/place.html');
  await move('wiki/place.html', 'wiki/Place.html');
  await move('book-1/chapters/one.html', 'book-2/chapters/one.html');
  await del('book-1/chapters/two.html');
  await create('book-1/chapters/two.html');
  await create('Wiki/other.html');

  // Then a seeded random run over a small pool of names, spelled in several cases so clashes happen.
  const rand = mulberry32(20261119);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const names = ['wiki/a.html', 'wiki/A.html', 'wiki/b.html', 'book-1/c.html', 'Book-1/c.html', 'book-1/d.html', 'x/y/z.html', 'x/y/Z.html', 'e.html', 'E.html'];
  for (let i = 0; i < 160; i += 1) {
    const p = pick(names);
    const roll = rand();
    if (!view.has(p)) await create(p);
    else if (roll < 0.4) await update(p);
    else if (roll < 0.6) await del(p);
    else await move(p, pick(names.filter((n) => n !== p)));
  }

  assert.ok(snapshots.length >= 60, `only ${snapshots.length} accepted changes`);
  assert.ok(tally.move >= 1 && tally.delete >= 1 && tally.caseMove >= 1 && tally.update >= 1 && tally.rejected >= 1, JSON.stringify(tally));

  const serverView = await replay(client, new Map(), 0, 500);
  assert.deepEqual([...serverView].sort(), [...view].sort(), 'the live set from since=0 is the client view');
  for (const { seq, view: seen } of snapshots) {
    for (const limit of [1, 3]) {
      assert.deepEqual([...await replay(client, seen, seq, limit)].sort(), [...serverView].sort(), `from seq ${seq}, limit ${limit}`);
    }
  }
  for (const [p, version] of serverView) {
    const got = await client.get(p);
    assert.equal(got.headers.etag, `"${version}"`);
    assert.equal(blob(got.body), version, p);
  }
  assert.deepEqual(listDisk(path.join(h.repo, 'library')).sort(), [...serverView.keys()].sort(), 'the disk holds exactly the live set');
});
