// Rules: the page channels answer the window half with checked payloads (a malformed
// request is rejected, never half carried out), return what the store returns, and a
// rename left part way is finished when the main half starts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPages } from '../../src/hoard/pages/main.ts';
import { PageStore } from '../../src/hoard/pages/store.ts';
import { pagesLibrary } from './pages-support.ts';

function host(library: string) {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const logs: { level: string; message: string }[] = [];
  const fake = {
    handle: (channel: string, fn: (payload: unknown) => unknown) => { handlers.set(channel, fn); },
    log: (level: string, message: string) => { logs.push({ level, message }); },
    paths: { library: () => library },
  };
  const call = async (channel: string, payload?: unknown) => handlers.get(channel)!(payload);
  return { fake: fake as unknown as NeoMainHost, call, handlers, logs };
}

test('the five channels list, read, write, create and rename pages', async (t) => {
  const { library, put, get } = pagesLibrary(t);
  put('wiki/Tide.html', '<p>one</p>');
  put('sources/Notes.html', '<p>[[Tide]]</p>');
  const h = host(library);
  startPages(h.fake, undefined);
  assert.deepEqual([...h.handlers.keys()].sort(), ['pages.create', 'pages.list', 'pages.read', 'pages.rename', 'pages.write']);

  const listed = (await h.call('pages.list')) as { id: string }[];
  assert.deepEqual(listed.map((p) => p.id), ['sources/Notes.html', 'wiki/Tide.html']);
  assert.equal(((await h.call('pages.read', { id: 'wiki/Tide.html' })) as { html: string }).html, '<p>one</p>');
  assert.deepEqual(await h.call('pages.write', { id: 'wiki/Tide.html', before: '<p>one</p>', after: '<p>two</p>' }), { ok: true });
  assert.equal(get('wiki/Tide.html'), '<p>two</p>');
  const made = (await h.call('pages.create', { tree: 'wiki', path: 'Moon.html', html: '<p>m</p>' })) as { id: string };
  assert.equal(made.id, 'wiki/Moon.html');
  const renamed = (await h.call('pages.rename', { id: 'wiki/Tide.html', newPath: 'Surf.html', openBookId: null })) as { id: string; rewrittenFiles: number };
  assert.equal(renamed.id, 'wiki/Surf.html');
  assert.equal(renamed.rewrittenFiles, 1);
  assert.equal(get('sources/Notes.html'), '<p>[[Surf]]</p>');
});

test('a malformed request is rejected before the store sees it', async (t) => {
  const { library, put, has } = pagesLibrary(t);
  put('wiki/Tide.html', '<p>one</p>');
  const h = host(library);
  startPages(h.fake, undefined);
  const bad: [string, unknown][] = [
    ['pages.read', {}], ['pages.read', { id: 7 }], ['pages.read', { id: 'wiki/Tide.html', extra: 1 }],
    ['pages.write', { id: 'wiki/Tide.html', before: 'x' }],
    ['pages.create', { tree: 'elsewhere', path: 'A.html', html: '' }], ['pages.create', { tree: 'wiki', path: 'A.html' }],
    ['pages.rename', { id: 'wiki/Tide.html', newPath: 'A.html' }], ['pages.rename', { id: 'wiki/Tide.html', newPath: 'A.html', openBookId: 3 }],
  ];
  for (const [channel, payload] of bad) await assert.rejects(Promise.resolve().then(() => h.call(channel, payload)), TypeError, `${channel} ${JSON.stringify(payload)}`);
  assert.equal(has('wiki/A.html'), false);
  assert.equal(has('wiki/Tide.html'), true);
});

test('a path out of the tree is refused through the channel and logged', async (t) => {
  const { library, has } = pagesLibrary(t);
  const h = host(library);
  startPages(h.fake, undefined);
  await assert.rejects(h.call('pages.create', { tree: 'wiki', path: '../Out.html', html: 'x' }), /not a page path/);
  await assert.rejects(h.call('pages.read', { id: 'wiki/../../etc/passwd' }), /not a page path/);
  assert.equal(has('Out.html'), false);
  assert.equal(h.logs.filter((l) => l.level === 'warn').length, 2);
});

test('starting finishes a rename that was left part way, and says so', async (t) => {
  let n = 0;
  const left = pagesLibrary(t, { onStep: (step: string) => { if (step === 'rewrite' && ++n === 2) throw new Error('power cut'); } });
  left.put('wiki/Tide.html', '<p>x</p>');
  left.put('wiki/A.html', '<p>[[Tide]]</p>');
  left.put('sources/B.html', '<p>[[Tide]]</p>');
  await assert.rejects(left.store.rename('wiki/Tide.html', 'Surf.html', null), /power cut/);
  assert.equal(left.has('.neo/pages/.rename.json'), true);

  const h = host(left.library);
  const recovered = startPages(h.fake, undefined);
  await recovered.recovery;
  assert.equal(left.has('.neo/pages/.rename.json'), false);
  assert.equal(left.get('wiki/A.html'), '<p>[[Surf]]</p>');
  assert.equal(left.get('sources/B.html'), '<p>[[Surf]]</p>');
  assert.ok(recovered.store instanceof PageStore);
});
