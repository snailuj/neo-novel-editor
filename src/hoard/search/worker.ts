// The search worker, a utility process the main half starts on the first search
// (client.ts). It holds the library's text in memory (library.ts) and answers each
// search with its id. It writes nothing.
import { LibraryIndex } from './library.ts';
import type { Answer } from './client.ts';
import type { LibraryQuery } from './library.ts';

// stderr reaches NEO's log through the utility process; only what needs a look is sent
const index = new LibraryIndex({
  log: (level, message, data) => { if (level === 'warn' || level === 'error') console.error(`search: ${message}`, data ?? ''); },
});
const port = (process as unknown as { parentPort: Electron.ParentPort }).parentPort;

port.on('message', async (event) => {
  const { id, root, query } = event.data as { id: number; root: string; query: LibraryQuery };
  let answer: Answer;
  try {
    const found = await index.search(root, query);
    answer = { id, ok: true, found, stats: index.stats() };
  } catch (err) {
    answer = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(answer);
});
