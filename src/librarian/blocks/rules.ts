// The labels, and the few that need no judge: blocks that are plainly page structure
// (frontmatter, comments, embeds, `Field:: value` lines). Everything else is judged,
// because whether a paragraph is a story idea or a journal line is a reading, not a rule.
import type { Block } from './split.ts';

export const LABELS = ['writing', 'morning-pages', 'tasks', 'other'] as const;
export type Label = (typeof LABELS)[number];

export const isLabel = (value: string): value is Label => (LABELS as readonly string[]).includes(value);

const EMBED = /^\s*!\[\[[^\]]+\]\]\s*$/;
const FIELD = /^\s*[\w][\w ./-]*::\s*.*$/;
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]/;
export const MORNING_PAGES = /morning pages/i;

export function ruleLabel(block: Block): { label: Label; reason: string } | null {
  if (block.kind === 'frontmatter') return { label: 'other', reason: 'frontmatter' };
  if (block.kind === 'comment') return { label: 'other', reason: 'comment' };
  const lines = block.text.split('\n').filter((l) => l.trim() !== '');
  if (lines.every((l) => EMBED.test(l))) return { label: 'other', reason: 'embed' };
  if (block.kind === 'paragraph' && lines.every((l) => FIELD.test(l) || EMBED.test(l))) return { label: 'other', reason: 'metadata field' };
  return null;
}

/** The guess that stands when there is no judge: always marked for the author to check. */
export function fallbackGuess(block: Block): Label {
  if (block.kind === 'list-item' && CHECKBOX.test(block.text.split('\n')[0]!)) return 'tasks';
  if (block.heading.some((h) => MORNING_PAGES.test(h))) return 'morning-pages';
  return 'other';
}
