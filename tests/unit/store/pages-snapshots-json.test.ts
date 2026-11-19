import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { harness } from './support.ts';

// Rules for the pages and files beside the chapters. A notes or outline page that cannot be
// read is an error and never an empty page; a page another device wrote is kept as a .bak
// before it is replaced. A snapshot's files are written once and never rewritten. A JSON
// sidecar is never read as empty while a copy of it exists.

const NAMES = ['notes', 'outline'] as const;

test('a notes page round-trips; a page the book has never had is null, not empty text', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  assert.equal(await h.store.readAux(book.id, 'notes'), '', 'a fresh book has an empty page');
  assert.equal(await h.store.writeAux(book.id, 'notes', '<p>margin</p>'), true);
  assert.equal(await h.store.readAux(book.id, 'notes'), '<p>margin</p>');
  assert.equal(h.read(book.id, 'notes.html'), '<p>margin</p>');
  assert.equal(await h.store.readAux(book.id, 'notes-ch-aaa'), null);
  assert.equal(await h.store.readAux(book.id, 'no-such-page'), null);
});

test('a page the disk cannot read is unreadable, and is never replaced by a save', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  fs.rmSync(h.at(book.id, 'outline.html'));
  fs.mkdirSync(h.at(book.id, 'outline.html'));
  await assert.rejects(h.store.readAux(book.id, 'outline'), { code: 'unreadable' });
  await assert.rejects(h.store.writeAux(book.id, 'outline', '<p>x</p>', '<p>x</p>'));
  assert.ok(fs.statSync(h.at(book.id, 'outline.html')).isDirectory());
  assert.equal(fs.existsSync(h.at(book.id, 'outline.html.bak')), false);
});

test('a page in iCloud is waited for and read; one that never comes is cloud_only, and a save never goes over it', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const file = h.at(book.id, 'notes.html');
  fs.writeFileSync(file, 'placeholder');
  h.away.add(file);
  h.arrive.set(file, '<p>Ferry at dawn.</p>');
  assert.equal(await h.store.readAux(book.id, 'notes'), '<p>Ferry at dawn.</p>');

  fs.writeFileSync(file, 'placeholder');
  h.away.add(file);
  h.arrive.clear();
  await assert.rejects(h.store.readAux(book.id, 'notes'), { code: 'cloud_only' });
  await assert.rejects(h.store.writeAux(book.id, 'notes', '<p>new</p>'), { code: 'cloud_only' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'placeholder');
});

test('a stale save keeps the other device’s version as a .bak, and a retry makes no more copies', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  for (const name of NAMES) {
    const base = '<p>shared</p>';
    assert.equal(await h.store.writeAux(book.id, name, base), true);
    // the other device saves its own line over the same page
    const other = '<p>shared</p><p>other device line</p>';
    h.write([book.id, name + '.html'], other);
    const mine = '<p>shared</p><p>this device line</p>';
    assert.deepEqual(await h.store.writeAux(book.id, name, mine, base), { kept: name + '.html.bak' });
    assert.equal(h.read(book.id, name + '.html'), mine);
    assert.equal(h.read(book.id, name + '.html.bak'), other);
    assert.match(h.logs.join('\n'), new RegExp(`conflict: ${book.id}/${name}`));
    // a retry of the same stale save, or the same text again, makes no copy
    assert.equal(await h.store.writeAux(book.id, name, mine, base), true);
    assert.equal(await h.store.writeAux(book.id, name, mine, mine), true);
    assert.equal(fs.existsSync(h.at(book.id, name + '.html.bak2')), false);
    // a third device's different words are kept too, and the first copy stays
    h.write([book.id, name + '.html'], '<p>third device words</p>');
    assert.deepEqual(await h.store.writeAux(book.id, name, '<p>mine again</p>', mine), { kept: name + '.html.bak2' });
    assert.equal(h.read(book.id, name + '.html.bak'), other);
    assert.equal(h.read(book.id, name + '.html.bak2'), '<p>third device words</p>');
  }
});

test('a clean page saves with no copy', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  assert.equal(await h.store.writeAux(book.id, 'notes', '<p>one</p>'), true);
  assert.equal(await h.store.writeAux(book.id, 'notes', '<p>two</p>', '<p>one</p>'), true);
  assert.equal(fs.existsSync(h.at(book.id, 'notes.html.bak')), false);
  assert.equal(h.read(book.id, 'notes.html'), '<p>two</p>');
});

test('a page saved for the first time with an expected text has nothing to keep', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  assert.equal(await h.store.writeAux(book.id, 'notes-ch-1', '<p>one</p>', ''), true);
  assert.equal(h.read(book.id, 'notes-ch-1.html'), '<p>one</p>');
});

test('a snapshot file is written once; a second write of the same name changes nothing', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const snap = '20261001T000000Z-d-1-10-aaaa';
  assert.equal(await h.store.writeSnapshotFile(book.id, snap, 'ch-a.html', '<p>A</p>'), true);
  assert.equal(await h.store.writeSnapshotFile(book.id, snap, 'ch-a.html', '<p>changed</p>'), false);
  assert.equal(await h.store.readSnapshotFile(book.id, snap, 'ch-a.html'), '<p>A</p>');
  await h.store.writeSnapshotFile(book.id, snap, 'snapshot.json', '{}');
  assert.deepEqual(await h.store.listSnapshots(book.id), [{ name: snap, files: ['ch-a.html', 'snapshot.json'] }]);
});

test('the snapshot list holds snapshot folders only, and no snapshots is an empty list', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  assert.deepEqual(await h.store.listSnapshots(book.id), []);
  h.write([book.id, 'snapshots', 'good-1', 'ch-a.html'], 'x');
  h.write([book.id, 'snapshots', 'good-1', 'notes.txt'], 'x');
  h.write([book.id, 'snapshots', 'not a snapshot', 'ch-a.html'], 'x');
  h.write([book.id, 'snapshots', 'stray.json'], 'x');
  assert.deepEqual(await h.store.listSnapshots(book.id), [{ name: 'good-1', files: ['ch-a.html'] }]);
});

test('a snapshot file that cannot be read throws, so thinning never carries an empty stand-in forward', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const snap = '20261001T000000Z-d-1-10-aaaa';
  h.write([book.id, 'snapshots', snap, 'ch-a.html'], '');
  assert.equal(await h.store.readSnapshotFile(book.id, snap, 'ch-a.html'), '', 'a chapter that really is empty reads as empty');
  await assert.rejects(h.store.readSnapshotFile(book.id, snap, 'ch-missing.html'), { code: 'not_found', message: /ENOENT/ });
  const file = h.at(book.id, 'snapshots', snap, 'ch-a.html');
  fs.writeFileSync(file, 'x');
  h.away.add(file);
  await assert.rejects(h.store.readSnapshotFile(book.id, snap, 'ch-a.html'), { code: 'cloud_only' });
});

test('a name or file that is not a snapshot file is refused', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const snap = '20261001T000000Z-d-1-10-aaaa';
  await assert.rejects(h.store.readSnapshotFile(book.id, snap, '../book.json'), { code: 'bad_name' });
  await assert.rejects(h.store.readSnapshotFile(book.id, '../x', 'ch-a.html'), { code: 'bad_name' });
  await assert.rejects(h.store.readSnapshotFile(book.id, 'a b', 'ch-a.html'), { code: 'bad_name', message: /Invalid snapshot name/ });
  await assert.rejects(h.store.writeSnapshotFile(book.id, snap, 'x.exe', 'x'), { code: 'bad_name', message: /Invalid snapshot file/ });
  await assert.rejects(h.store.writeSnapshotFile(book.id, snap, '.hidden.html', 'x'), { code: 'bad_name' });
});

test('removing a snapshot takes its folder, and one that is not there is no error', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const snap = '20261001T000000Z-d-1-10-aaaa';
  await h.store.writeSnapshotFile(book.id, snap, 'ch-a.html', 'x');
  assert.equal(await h.store.removeSnapshot(book.id, snap), true);
  assert.equal(fs.existsSync(h.at(book.id, 'snapshots', snap)), false);
  assert.equal(await h.store.removeSnapshot(book.id, snap), true);
  assert.equal(await h.store.removeSnapshot(book.id, '../book'), true, 'a bad name removes nothing, and is logged');
  assert.ok(fs.existsSync(h.at(book.id, 'book.json')));
  assert.match(h.logs.join('\n'), /snapshot remove: .*Invalid library name/);
});

test('a sidecar round-trips whole with no .tmp, and a missing one reads as its fallback', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const data = { kept: ['a line the writer cut'] };
  assert.equal(await h.store.writeJSON(book.id, 'darlings', data), true);
  assert.equal(fs.existsSync(h.at(book.id, 'darlings.json.tmp')), false);
  assert.equal(h.read(book.id, 'darlings.json'), JSON.stringify(data, null, 2));
  assert.deepEqual(await h.store.readJSON(book.id, 'darlings', null), data);
  assert.equal(await h.store.readJSON(book.id, 'no-such-sidecar', 'fallback'), 'fallback');
});

test('a sidecar left only as its .tmp is recovered, not read as empty', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  h.write([book.id, 'keepers.json.tmp'], JSON.stringify([{ id: 'd1', text: 'recover me' }]));
  assert.deepEqual(await h.store.readJSON(book.id, 'keepers', []), [{ id: 'd1', text: 'recover me' }]);
});

test('a sidecar in iCloud is an error, not its fallback', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  h.away.add(h.at(book.id, 'darlings.json'));
  await assert.rejects(h.store.readJSON(book.id, 'darlings', []), { code: 'cloud_only' });
});

// Every book, chapter, page, snapshot and sidecar name is one plain name inside the library.
test('a name that is not one plain name creates nothing and writes nothing outside the library', async () => {
  const outer = harness();
  const h = harness({ dir: outer.at('library') });
  fs.mkdirSync(h.dir);
  const book = await h.store.createBook({ title: 'Hello' });
  const before = fs.readdirSync(outer.dir).sort();
  const chaptersBefore = fs.readdirSync(h.at(book.id, 'chapters'));
  const bad = ['', '.', '..', 'a/b', 'a\\b', 'a\0b'];
  for (const name of bad) {
    const calls: Promise<unknown>[] = [
      h.store.writeChapter(name, 'c1', '<p>no</p>'),
      h.store.writeChapter(book.id, name, '<p>no</p>'),
      h.store.readChapter(book.id, name),
      h.store.deleteChapter(book.id, name),
      h.store.writeAux(book.id, name, '<p>no</p>'),
      h.store.readAux(book.id, name),
      h.store.writeJSON(name, 'darlings', []),
      h.store.writeJSON(book.id, name, []),
      h.store.readJSON(book.id, name, null),
      h.store.readBookMeta(name),
      h.store.writeBookMeta(name, book),
      h.store.duplicateBook(name, 'x'),
      h.store.writeSnapshotFile(name, 'snap', 'a.html', 'x'),
    ];
    for (const call of calls) await assert.rejects(call, { code: 'bad_name', message: /Invalid library name/ }, JSON.stringify(name));
  }
  assert.deepEqual(fs.readdirSync(outer.dir).sort(), before);
  assert.deepEqual(fs.readdirSync(h.at(book.id, 'chapters')), chaptersBefore);
  assert.equal(fs.existsSync(outer.at('c1.html')), false);
});
