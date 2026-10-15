// The main half's channels for the librarian's commit pair: the window begins an edit,
// applies it, and ends it, and every chapter write that lands wakes a wait on the disk.
import { validateHoardGitLibrarianBeginV1, validateHoardGitLibrarianEndV1 } from '../../generated/validators.cjs';
import type { GitLayer } from './layer.ts';
import { LibrarianPairs } from './pair.ts';

function checked<T>(name: string, validate: { (data: unknown): data is T; errors?: { instancePath: string; message?: string }[] | null }, payload: unknown): T {
  if (!validate(payload)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`${name}: ${why}`);
  }
  return payload;
}

export function startLibrarianPairs(host: NeoMainHost, layer: GitLayer): LibrarianPairs {
  const pairs = new LibrarianPairs({ layer, library: () => host.paths.library(), log: host.log.bind(host) });
  host.onAfterWrite((event) => {
    if (event.kind === 'chapter') pairs.landed(event.bookId, event.name);
  });
  host.handle('git.librarian-begin', (payload) => pairs.begin(checked('git.librarian-begin', validateHoardGitLibrarianBeginV1, payload)));
  host.handle('git.librarian-end', (payload) => pairs.end(checked('git.librarian-end', validateHoardGitLibrarianEndV1, payload)));
  return pairs;
}
