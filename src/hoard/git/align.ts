// Puts blame lines against the window's paragraphs. The chapter driver gives each
// top-level block a line, and a list or a quotation holds several paragraphs in one;
// the window counts every <p> in order. Each <p> in a line takes that line's blame,
// provided its text is the paragraph's text; one that differs (written since the save,
// say) is credited to no one rather than to the wrong person.
import type { BlameLine } from './blame.ts';

const P = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

export function alignBlame<L extends BlameLine>(lines: readonly L[], paragraphs: readonly string[]): (L | null)[] {
  const out: (L | null)[] = paragraphs.map(() => null);
  let i = 0;
  for (const line of lines) {
    for (const m of line.html.matchAll(P)) {
      if (i >= paragraphs.length) return out;
      if (text(m[1]) === paragraphs[i]) out[i] = line;
      i++;
    }
  }
  return out;
}
