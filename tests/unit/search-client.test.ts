// Rules for the main half's way to the search worker: the worker starts on the first
// search, not before; each answer goes to the search that asked; a worker that stops
// fails what was waiting, with a reason, and the next search starts a new one; and one
// line logs the first search's numbers.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SearchClient, type WorkerProcess } from '../../src/hoard/search/client.ts';

class FakeWorker extends EventEmitter implements WorkerProcess {
  sent: { id: number; root: string; query: unknown }[] = [];
  killed = false;
  postMessage(message: { id: number; root: string; query: unknown }) { this.sent.push(message); }
  kill() { this.killed = true; return true; }
  answer(n: number, extra: Record<string, unknown> = {}) {
    const { id } = this.sent[n]!;
    this.emit('message', { id, ok: true, found: { groups: [], total: id, capped: false, cloud: 0, unreadable: 0 }, stats: { books: 1 }, ...extra });
  }
}

const query = { text: 'tide', scope: 'all' as const, open: null, limit: 10, cap: 100 };

test('the worker starts on the first search, and each answer goes to the search that asked', async () => {
  const made: FakeWorker[] = [];
  const logs: [string, string][] = [];
  const client = new SearchClient({ start: () => { const w = new FakeWorker(); made.push(w); return w; }, library: () => '/lib', log: (level, message) => { logs.push([level, message]); } });
  assert.equal(made.length, 0);
  const one = client.search(query);
  const two = client.search({ ...query, text: 'salt' });
  assert.equal(made.length, 1);
  assert.deepEqual(made[0]!.sent.map((m) => [m.root, (m.query as { text: string }).text]), [['/lib', 'tide'], ['/lib', 'salt']]);
  made[0]!.answer(1);
  made[0]!.answer(0);
  assert.equal((await two).total, made[0]!.sent[1]!.id);
  assert.equal((await one).total, made[0]!.sent[0]!.id);
  assert.deepEqual(logs.filter(([level]) => level === 'info').map(([, m]) => m), ['search.ready']);
});

test('a worker that stops fails what waits, and the next search starts another', async () => {
  const made: FakeWorker[] = [];
  const client = new SearchClient({ start: () => { const w = new FakeWorker(); made.push(w); return w; }, library: () => '/lib', log: () => {} });
  const waiting = client.search(query);
  made[0]!.emit('exit', 3);
  await assert.rejects(waiting, /stopped \(exit code 3\)/);
  const again = client.search(query);
  assert.equal(made.length, 2);
  made[1]!.answer(0);
  await again;
});

test('an error the worker reports fails only its own search', async () => {
  const made: FakeWorker[] = [];
  const client = new SearchClient({ start: () => { const w = new FakeWorker(); made.push(w); return w; }, library: () => '/lib', log: () => {} });
  const bad = client.search(query);
  const good = client.search(query);
  const [first, second] = made[0]!.sent;
  made[0]!.emit('message', { id: first!.id, ok: false, error: 'the library is not there' });
  made[0]!.emit('message', { id: second!.id, ok: true, found: { groups: [], total: 0, capped: false, cloud: 0, unreadable: 0 }, stats: {} });
  await assert.rejects(bad, /the library is not there/);
  await good;
  client.stop();
  assert.equal(made[0]!.killed, true);
});
