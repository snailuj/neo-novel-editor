// The candidates as the judge reads them: a card per page, each naming its file. Under a
// budget, cards go in full in rank order while they fit, and every page after the first
// that does not becomes a locator line the judge can open; a page outside `fullOnly` is a
// locator whatever the budget. Pure, so it serves the app's wiki and the eval's vault alike.
import { card, type Corpus, type Ranked } from './shortlist.ts';

export interface CardPage {
  title: string;
  /** The page's file, as the judge opens it. */
  file: string;
  /** Said after the file on a full card. */
  note?: string;
}

export interface CardOptions {
  budgetChars?: number;
  fullOnly?: ReadonlySet<string>;
  /** A page by corpus path; by default the doc's name and its path. */
  pageOf?: (relpath: string) => CardPage | null;
}

export interface Cards {
  text: string;
  /** Titles, in rank order. */
  candidates: string[];
  /** Relpaths of the full cards and the locators, each in rank order. */
  full: string[];
  locator: string[];
  /** The full cards' characters, a newline each. */
  fullChars: number;
}

export function why(r: Ranked): string {
  return r.why === 'named' ? 'named' : r.why.startsWith('hop') ? r.why : r.why === 'lexical' ? 'shares words' : r.why === 'embedding' ? 'close in meaning' : r.why;
}

export function renderCards(corpus: Corpus, ranked: readonly Ranked[], o: CardOptions = {}): Cards {
  const pageOf = o.pageOf ?? ((rel: string): CardPage | null => {
    const doc = corpus.byRel.get(rel);
    return doc ? { title: doc.name, file: rel } : null;
  });
  const out: Cards = { text: '', candidates: [], full: [], locator: [], fullChars: 0 };
  const lines: string[] = [];
  let over = false;
  for (const r of ranked) {
    const doc = corpus.byRel.get(r.relpath);
    const page = pageOf(r.relpath);
    if (!doc || !page) continue;
    out.candidates.push(page.title);
    const w = why(r);
    const parts = card({ ...doc, name: page.title }, { ...r, why: w }).split('\n');
    parts.splice(1, 0, `  file: ${page.file}${page.note ? ` ${page.note}` : ''}`);
    const full = parts.join('\n');
    const eligible = !o.fullOnly || o.fullOnly.has(r.relpath);
    // Once one card overflows, the rest are locators too, so the full cards stay the best.
    if (eligible && !over && o.budgetChars !== undefined && out.fullChars + full.length + 1 > o.budgetChars) over = true;
    if (over || !eligible) {
      out.locator.push(r.relpath);
      lines.push(`- [[${page.title}]]${w ? ` (${w})` : ''} file: ${page.file}`);
    } else {
      out.full.push(r.relpath);
      out.fullChars += full.length + 1;
      lines.push(full);
    }
  }
  if (o.budgetChars !== undefined || o.fullOnly) {
    lines.push('', `${out.full.length} in full and ${out.locator.length} by name only. To read a page named only, open its file.`);
  }
  out.text = lines.join('\n');
  return out;
}
