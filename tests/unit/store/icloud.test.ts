import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createICloud, StoreError } from '../../../src/store/index.ts';

// Files iCloud has taken off a Mac are placeholders: a read of one waits on iCloud, for ever
// when iCloud is stuck. Rule: nothing here ever reads a placeholder, and nothing waits on
// one longer than `waitMs`. iCloud is played by the test: `away` is the set of files that are
// placeholders, and asking for one brings it back after a moment.

function fakeCloud(platform = 'darwin') {
  const away = new Set<string>();
  const asked: string[] = [];
  const arrive = new Map<string, number>(); // file -> ms until it is here when asked
  const icloud = createICloud({
    platform,
    waitMs: 400,
    detect: (files) => new Set(files.filter((f) => away.has(f))),
    download: (file, done) => {
      asked.push(file);
      if (arrive.has(file)) setTimeout(() => { away.delete(file); done(); }, arrive.get(file));
      else setTimeout(done, 10);
    },
    pollMs: 20,
  });
  return { icloud, away, asked, arrive };
}

test('with everything on this Mac, a read happens on the spot, not a promise later', () => {
  const { icloud, asked } = fakeCloud();
  const got = icloud.afterLocal(['/lib/a.html'], () => 'text', () => 'away');
  assert.equal(got, 'text');
  assert.deepEqual(asked, []);
});

test('a placeholder is asked for, waited for, and read once it has come', async () => {
  const { icloud, away, asked, arrive } = fakeCloud();
  away.add('/lib/a.html');
  arrive.set('/lib/a.html', 60);
  const got = icloud.afterLocal(['/lib/a.html'], () => 'text', () => 'away');
  assert.ok(got instanceof Promise, 'not read on the spot');
  assert.equal(await got, 'text');
  assert.deepEqual(asked, ['/lib/a.html']);
});

test('a placeholder that never comes is given up on after the wait, with the files still away', async () => {
  const { icloud, away } = fakeCloud();
  away.add('/lib/a.html');
  const t0 = Date.now();
  const left = await icloud.afterLocal<string | string[]>(['/lib/a.html', '/lib/b.html'], () => 'text', (files) => [...files]);
  assert.deepEqual(left, ['/lib/a.html']);
  assert.ok(Date.now() - t0 < 2000);
});

test('placeholders only exist on macOS: anywhere else nothing is in iCloud', () => {
  const sparse = path.join(fs.mkdtempSync(path.join(tmpdir(), 'neo-icloud-')), 'a.html');
  fs.closeSync(fs.openSync(sparse, 'w'));
  fs.truncateSync(sparse, 4096);
  assert.equal(createICloud({ platform: 'linux' }).isCloudOnly(sparse), false);
  assert.equal(createICloud({ platform: 'win32' }).cloudOnlyAmong([sparse]).size, 0);
  fs.rmSync(path.dirname(sparse), { recursive: true, force: true });
});

test('each file is asked for once however often it is wanted, a few at a time', async () => {
  const asks: string[] = [];
  let inFlight = 0;
  let most = 0;
  const icloud = createICloud({
    platform: 'darwin',
    detect: () => new Set(),
    download: (file, done) => {
      asks.push(file);
      most = Math.max(most, ++inFlight);
      setTimeout(() => { inFlight--; done(); }, 15);
    },
  });
  const files = Array.from({ length: 9 }, (_, i) => `/lib/${i}.html`);
  icloud.requestDownload(files);
  icloud.requestDownload(files);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(asks.sort(), [...files].sort());
  assert.ok(most <= 4 && most > 1, `${most} at once`);
  // once a file has come it can be asked for again (it may go back)
  icloud.requestDownload(files.slice(0, 1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(asks.length, 10);
});

test('the error for a placeholder is a cloud_only store error naming the file', () => {
  const { icloud } = fakeCloud();
  const err = icloud.cloudError('/lib/a.html');
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'cloud_only');
  assert.match(err.message, /\/lib\/a\.html/);
});
