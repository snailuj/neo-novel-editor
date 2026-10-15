// What an import will do, in words for the message box that asks the writer. Pure.
import type { Sorted, Verdict } from './store.ts';

const SHOWN = 12;

function names(verdicts: Verdict[], label = (v: Verdict) => v.name): string {
  const shown = verdicts.slice(0, SHOWN).map(label).join(', ');
  const more = verdicts.length - SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

export interface Summary {
  /** How many pages would come in. */
  count: number;
  message: string;
  detail: string;
}

export function describeSort(sorted: Sorted): Summary {
  const of = (kind: Verdict['kind']) => sorted.verdicts.filter((v) => v.kind === kind);
  const fresh = of('new');
  const marks = fresh.reduce((n, v) => n + (v.kind === 'new' ? v.page.marks.length : 0), 0);
  const parts: string[] = [];
  if (fresh.length) {
    const marked = marks ? ` Their ${marks} CriticMarkup mark${marks === 1 ? '' : 's'} become${marks === 1 ? 's a comment or suggestion' : ' comments and suggestions'}.` : '';
    parts.push(`Coming in: ${names(fresh)}.${marked}`);
  }
  if (of('same').length) parts.push(`Already in the wiki: ${names(of('same'))}.`);
  if (of('changed').length) {
    parts.push(`Not imported, because the file changed since it came in and the wiki page may hold newer words: ${names(of('changed'))}.`);
  }
  if (of('clash').length) parts.push(`Not imported, because a page of that name is already in the wiki or earlier in the list: ${names(of('clash'))}.`);
  if (of('unreadable').length) {
    parts.push(`Not read: ${names(of('unreadable'), (v) => `${v.name} (${v.kind === 'unreadable' ? v.why : ''})`)}.`);
  }
  const n = fresh.length;
  return {
    count: n,
    message: n ? `Import ${n} page${n === 1 ? '' : 's'} into the wiki?` : 'Every page picked is already in the wiki, or cannot come in.',
    detail: parts.join('\n\n'),
  };
}
