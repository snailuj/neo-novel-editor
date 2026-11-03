// What main does when a stored page changes: the one place a page save is announced outside
// the store. The librarian pair is woken by every save, since it waits on the disk for the
// writer's save (begin) and for its own (end); the gate is told only of the author's, since
// that is what makes a held page theirs again. A signal that throws is logged and the other
// still goes out.
import type { Gate } from '../git/gate.ts';
import type { PageChange, PageStore } from './store.ts';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void;

export function signalPageChanges(
  store: Pick<PageStore, 'onChange'>,
  gate: Pick<Gate, 'saved'>,
  pairs: { landed(target: { page: string }): void },
  log: Log,
): () => void {
  const tell = (change: PageChange, who: string, send: () => void) => {
    try {
      send();
      log('debug', 'pages.change.signal', { page: change.page, kind: change.kind, who: change.who, to: who });
    } catch (err) {
      log('error', 'pages.change.signal-failed', { page: change.page, kind: change.kind, to: who, why: String(err) });
    }
  };
  return store.onChange((change) => {
    if (change.who === 'author') tell(change, 'gate', () => gate.saved(change.page));
    tell(change, 'pair', () => pairs.landed({ page: change.page }));
  });
}
