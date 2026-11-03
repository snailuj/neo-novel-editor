// The librarian's watcher in the main half: the window hands over each chapter the
// writer leaves, and the writer's Stop Flagging This Page and Flag This Page Again.
import { validateHoardCompanionQuietV1, validateHoardCompanionReadV1 } from '../../generated/validators.cjs';
import type { GitLayer } from '../git/layer.ts';
import type { MarkStore } from '../marks/store.ts';
import { Companion, type PageSource, type ReadRequest } from './store.ts';

type Validator<T> = { (data: unknown): data is T; errors?: { instancePath: string; message?: string }[] | null };

function checked<T>(name: string, validate: Validator<T>, payload: unknown): T {
  if (!validate(payload)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`${name}: ${why}`);
  }
  return payload;
}

export function startCompanion(host: NeoMainHost, layer: GitLayer, marks: MarkStore, pages: PageSource): Companion {
  const companion = new Companion({
    library: () => host.paths.library(),
    marks,
    pages,
    head: () => layer.head(),
    wrote: (name) => layer.wrote(name),
    log: host.log.bind(host),
  });
  host.handle('companion.read', (payload) => companion.read(checked('companion.read', validateHoardCompanionReadV1, payload) as ReadRequest));
  host.handle('companion.quiet', (payload) => {
    const { page, quiet } = checked('companion.quiet', validateHoardCompanionQuietV1, payload);
    return companion.quiet(page, quiet);
  });
  host.handle('companion.state', () => companion.state());
  return companion;
}
