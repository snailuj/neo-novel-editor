// What the librarian says about a page a chapter names, ported from hoard's companion
// note, and which pages a chapter has already been told about. Pure.
//
// The words name the page as a link and say how it was found: a guess from a bare name,
// never a link the writer typed (snailuj's ruling of 22 September 2026). A page whose
// frontmatter says draft_status: pantsing is "an offering from the pantsing shelf", the
// spec's own words, and is never framed as a correction. The librarian gives no advice.
//
// The link's target is the page's title. Where the writer's words differ from it only
// in case they are the target, since a link resolves without case; otherwise they are
// its display text.
import type { Mark } from '../../generated/hoard-marks-v1.js';
import { key } from '../../librarian/links.ts';
import { linksIn } from '../wiki/links.ts';
import type { Mention, WikiPage } from './mentions.ts';

const OFFERING = 'an offering from the pantsing shelf';
const GUESS = 'matched as a bare name in your prose (a guess, not a link you typed)';

export function findingWords(mention: Mention): string {
  const { title } = mention.page;
  const written = mention.text;
  const link = key(written) === key(title) ? `[[${written}]]` : `[[${title}|${written}]]`;
  return mention.page.pantsing ? `${link}: ${OFFERING}; ${GUESS}.` : `${link}: ${GUESS}.`;
}

/**
 * The ids of the pages this chapter has been told about: those the librarian's findings
 * link to, in any state, so a resolved one is not made again. Its other comments (a
 * suggestion flagged, say) tell about nothing.
 */
export function reported(marks: readonly Mark[], pages: readonly WikiPage[]): Set<string> {
  const byKey = new Map<string, string>();
  for (const page of pages) if (!byKey.has(key(page.title))) byKey.set(key(page.title), page.id);
  const out = new Set<string>();
  for (const mark of marks) {
    const first = mark.thread[0];
    if (mark.created.who !== 'librarian' || !first?.body.includes(GUESS)) continue;
    const link = linksIn([first.body])[0];
    const id = link && byKey.get(key(link.target));
    if (id) out.add(id);
  }
  return out;
}
