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
  const moving = sorted.verdicts.filter((v) => v.kind === 'new' || v.kind === 'update' || v.kind === 'beside');
  const marks = moving.reduce((n, v) => n + ('page' in v ? v.page.marks.length : 0), 0);
  const files = new Set(moving.flatMap((v) => ('attachments' in v ? v.attachments.map((a) => a.file) : [])));
  const missing = [...new Set(moving.flatMap((v) => ('missing' in v ? v.missing : [])))];
  const parts: string[] = [];
  if (fresh.length) parts.push(`Coming in: ${names(fresh)}.`);
  if (of('update').length) parts.push(`Updated from a newer source, since NEO has not changed the page: ${names(of('update'))}.`);
  if (of('beside').length) {
    parts.push(`Coming in beside its page, because the source and the page in NEO have both changed: ${names(of('beside'))}.`);
  }
  if (marks) parts.push(`${marks} CriticMarkup mark${marks === 1 ? ' becomes a comment or suggestion' : 's become comments and suggestions'}.`);
  if (files.size) parts.push(`${files.size} image${files.size === 1 ? '' : 's'} or PDF${files.size === 1 ? '' : 's'} the pages show ${files.size === 1 ? 'is' : 'are'} copied into the wiki.`);
  if (missing.length) parts.push(`Not found beside the pages, so not copied: ${missing.slice(0, SHOWN).join(', ')}${missing.length > SHOWN ? ` and ${missing.length - SHOWN} more` : ''}.`);
  if (of('same').length) parts.push(`Already in the wiki: ${names(of('same'))}.`);
  if (of('through-hoard').length) parts.push(`Already in hoard, so they come in with hoard's pages: ${names(of('through-hoard'))}.`);
  if (of('hoard-older').length) {
    parts.push(`Not imported, because hoard holds an older copy, which comes in with hoard's pages: ${names(of('hoard-older'))}.`);
  }
  if (of('clash').length) parts.push(`Not imported, because a page of that name is already in the wiki or earlier in the list: ${names(of('clash'))}.`);
  if (of('unreadable').length) {
    parts.push(`Not read: ${names(of('unreadable'), (v) => `${v.name} (${v.kind === 'unreadable' ? v.why : ''})`)}.`);
  }
  const n = moving.length;
  return {
    count: n,
    message: n ? `Import ${n} page${n === 1 ? '' : 's'} into the wiki?` : 'Every page picked is already in the wiki, or cannot come in.',
    detail: parts.join('\n\n'),
  };
}
