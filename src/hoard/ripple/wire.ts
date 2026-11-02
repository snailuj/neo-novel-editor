// Ripple as the plugin builds it: the page store, the mark store, the owner reader and the
// git layer's blame by page. Kept apart from main.ts, which needs Electron, so a test can
// build the same Ripple.
import type { GitLayer } from '../git/layer.ts';
import type { MarkStore } from '../marks/store.ts';
import type { PageStore } from '../pages/store.ts';
import { ownerOf } from '../review/owner.ts';
import { Ripple } from './engine.ts';

export function makeRipple(host: { library: () => string; log: (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void }, layer: GitLayer, pages: PageStore, marks: MarkStore): Ripple {
  return new Ripple({
    library: host.library,
    pages,
    marks,
    ownerOf: (root, page) => ownerOf(root, page, host.log),
    layer,
    blame: (page) => layer.blame({ page }),
    wrote: (name) => layer.wrote(name),
    log: host.log,
  });
}
