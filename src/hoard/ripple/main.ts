// Ripple's channels on the main side. Run Ripple from the Plugins menu with no book open
// says what it did in a message box, as Keep Library History does: the writer asked.
import { BrowserWindow, dialog, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { validateHoardRippleAskV1, validateHoardRippleDecideV1, validateHoardRippleRunV1 } from '../../generated/validators.cjs';
import type { GitLayer } from '../git/layer.ts';
import type { MarkStore } from '../marks/store.ts';
import type { WikiStore } from '../wiki/store.ts';
import { Ripple } from './engine.ts';
import { describeRun } from './summary.ts';

type Validator<T> = { (data: unknown): data is T; errors?: { instancePath: string; message?: string }[] | null };

function checked<T>(name: string, validate: Validator<T>, payload: unknown): T {
  if (!validate(payload)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`${name}: ${why}`);
  }
  return payload;
}

export function startRipple(host: NeoMainHost, layer: GitLayer, marks: MarkStore, wiki: WikiStore): Ripple {
  const ripple = new Ripple({
    library: () => host.paths.library(),
    wiki,
    marks,
    layer,
    wrote: (name) => layer.wrote(name),
    log: host.log.bind(host),
  });
  host.handle('ripple.run', async (payload) => {
    const { tell } = checked('ripple.run', validateHoardRippleRunV1, payload);
    const summary = await ripple.run();
    if (tell) {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = { type: 'info' as const, ...describeRun(summary) };
      await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    }
    return { ...summary, said: describeRun(summary) };
  });
  host.handle('ripple.ask', (payload) => ripple.ask(checked('ripple.ask', validateHoardRippleAskV1, payload)));
  host.handle('ripple.decide', (payload) => {
    const { openBookId, id, decision } = checked('ripple.decide', validateHoardRippleDecideV1, payload);
    return ripple.decide(openBookId, id, decision);
  });
  host.handle('ripple.overview', () => ripple.overview());
  host.handle('ripple.folder', async () => {
    const { packets } = ripple.overview();
    mkdirSync(packets, { recursive: true });
    const failed = await shell.openPath(packets);
    if (failed) throw new Error(failed);
    return null;
  });
  return ripple;
}
