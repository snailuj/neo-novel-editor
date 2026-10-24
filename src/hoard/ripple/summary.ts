// What a ripple run did, as the writer reads it in a message box. Pure.
import type { RunSummary } from './engine.ts';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a run did, as a sentence or two for the writer. */
export function describeRun(s: RunSummary): { message: string; detail: string } {
  if (!s.wiki) return { message: 'There is no wiki yet.', detail: 'Ripple carries changes through the wiki. Import pages to the wiki first.' };
  if (s.baseline) return { message: 'Ripple is watching the wiki from now on.', detail: 'Pages you import or change from here on get a packet for the judge the next time Ripple runs. For a chapter you want judged now, use Ripple This Chapter.' };
  const parts: string[] = [];
  if (s.packeted) parts.push(`${plural(s.packeted, 'packet')} for the judge ${s.packeted === 1 ? 'is' : 'are'} in ${s.packets}.`);
  if (s.read) {
    const repeats = s.repeats === 1
      ? ' 1 more repeated a card you have waiting or rejected, so no new card was made for it.'
      : s.repeats ? ` ${s.repeats} more repeated cards you have waiting or rejected, so no new cards were made for them.` : '';
    parts.push(`${plural(s.read, 'answer')} came in, with ${plural(s.proposals, 'proposal')} for you to rule on beside any book.${repeats}`);
  }
  if (s.problems.length) parts.push(`${plural(s.problems.length, 'answer')} could not be taken:\n${s.problems.join('\n')}`);
  if (!parts.length) return { message: 'Nothing new for ripple.', detail: 'No page changed since the last run, and no answer is waiting.' };
  return { message: s.read ? 'Ripple read the judge\'s answers.' : 'Ripple wrote packets for the judge.', detail: parts.join('\n\n') };
}
