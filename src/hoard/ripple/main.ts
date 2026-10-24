// Ripple's channels on the main side. Run Ripple from the Plugins menu with no book open
// says what it did in a message box, as Keep Library History does: the writer asked.
import { BrowserWindow, dialog, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { validateHoardRippleAskV1, validateHoardRippleDecideV1, validateHoardRippleRunV1 } from '../../generated/validators.cjs';
import type { GitLayer } from '../git/layer.ts';
import type { MarkStore } from '../marks/store.ts';
import type { WikiStore } from '../wiki/store.ts';
import { Ripple, type RunSummary } from './engine.ts';

type Validator<T> = { (data: unknown): data is T; errors?: { instancePath: string; message?: string }[] | null };

function checked<T>(name: string, validate: Validator<T>, payload: unknown): T {
  if (!validate(payload)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`${name}: ${why}`);
  }
  return payload;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a run did, as a sentence or two for the writer. */
export function describeRun(s: RunSummary): { message: string; detail: string } {
  if (!s.wiki) return { message: 'There is no wiki yet.', detail: 'Ripple carries changes through the wiki. Import pages to the wiki first.' };
  if (s.baseline) return { message: 'Ripple is watching the wiki from now on.', detail: 'Pages you import or change from here on get a packet for the judge the next time Ripple runs. For a chapter you want judged now, use Ripple This Chapter.' };
  const parts: string[] = [];
  if (s.packeted) parts.push(`${plural(s.packeted, 'packet')} for the judge ${s.packeted === 1 ? 'is' : 'are'} in ${s.packets}.`);
  if (s.read) parts.push(`${plural(s.read, 'answer')} came in, with ${plural(s.proposals, 'proposal')} for you to rule on beside any book.`);
  if (s.problems.length) parts.push(`${plural(s.problems.length, 'answer')} could not be taken:\n${s.problems.join('\n')}`);
  if (!parts.length) return { message: 'Nothing new for ripple.', detail: 'No page changed since the last run, and no answer is waiting.' };
  return { message: s.read ? 'Ripple read the judge\'s answers.' : 'Ripple wrote packets for the judge.', detail: parts.join('\n\n') };
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
