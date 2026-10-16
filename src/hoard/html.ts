// A chapter file's paragraphs as the window reads them. The window counts every <p> in
// a chapter, in order, and a place's offsets count each one's textContent, so this reads
// the file the same way: tags dropped, entities read. NEO writes its chapters through
// the page's own serialiser, which escapes only &, <, > and the no-break space, so the
// short list of named entities is all a chapter holds; any other stays as written.

const P = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The text of a fragment of a paragraph's HTML, as textContent reads it. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

/** Each <p>'s inner HTML, in order. */
export function paragraphHtml(html: string): string[] {
  return [...html.matchAll(P)].map((m) => m[1]!);
}

/** Each <p>'s text, in order. */
export function paragraphTexts(html: string): string[] {
  return paragraphHtml(html).map(textOf);
}
