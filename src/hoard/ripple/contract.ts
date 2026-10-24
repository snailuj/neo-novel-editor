// The judge's answer, as ripple reads it: one JSON line of preflight, then a line per
// proposal (schemas/ripple-output-v1.json). The preflight proves the judge read the
// brief, which the packet never holds: it echoes at least 40 characters of the brief
// that the packet does not contain. And every proposal rests on a quote of the source.
//
// Two of hoard's rules broke its own runs, so both are kept here in the form its rulebook
// meant: an echo is compared with Markdown emphasis stripped, since a judge drops bold
// markers when it copies; and a quote may hold [the judge's own words] and ... gaps, as
// quotations do. Pure.
import type { RippleClaim, RippleMint, RippleNothing, RippleOutputV1, RippleTopic } from '../../generated/ripple-output-v1.js';
import { validateRippleOutputV1 } from '../../generated/validators.cjs';

export type Proposed = RippleNothing | RippleClaim | RippleTopic | RippleMint;

export const ECHO_MIN = 40;
export const QUOTE_MIN = 12;

export class AnswerError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'AnswerError';
  }
}

// [[Target|Shown]] reads as Shown and [[Target]] as Target, as the page shows a link.
const links = (text: string) => text.replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t: string, shown?: string) => shown ?? t);

/** Text as a comparison reads it: links as shown, emphasis gone, quotes plain, spaces one. */
export function plainText(text: string): string {
  return links(text.normalize('NFC'))
    .replace(/(\*\*|__|\*|_|~~|==|`)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a quote is the source's words: each run of it between [insertions] and ...
 * gaps is found in the source, in order, case aside, and the runs hold at least
 * QUOTE_MIN characters between them.
 */
export function quoteIn(quote: string, source: string): boolean {
  const pieces = links(quote).split(/\[[^\]]*\]|\.\.\.|…/).map((p) => plainText(p).toLowerCase()).filter(Boolean);
  if (pieces.reduce((n, p) => n + p.length, 0) < QUOTE_MIN) return false;
  const hay = plainText(source).toLowerCase();
  let from = 0;
  for (const piece of pieces) {
    const at = hay.indexOf(piece, from);
    if (at === -1) return false;
    from = at + piece.length;
  }
  return true;
}

export interface Brief {
  text: string;
  sha256: string;
}

export interface Answer {
  proposals: Proposed[];
}

function why(errors: typeof validateRippleOutputV1.errors): string {
  const all = errors ?? [];
  // oneOf reports every branch; the kind's own complaints are the useful ones
  const own = all.filter((e) => e.instancePath !== '' || e.keyword !== 'oneOf');
  return (own.length ? own : all).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
}

/** Reads an answer file; throws AnswerError naming the line that does not do. */
export function readAnswer(text: string, brief: Brief, packet: string): Answer {
  const lines = text.split('\n').map((line, i) => ({ line, n: i + 1 })).filter((l) => l.line.trim());
  if (!lines.length) throw new AnswerError('the answer is empty');
  const parsed = lines.map(({ line, n }) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      throw new AnswerError(`line ${n} is not JSON: ${(err as Error).message}`);
    }
    if (!validateRippleOutputV1(value)) throw new AnswerError(`line ${n} is not a ripple answer line: ${why(validateRippleOutputV1.errors)}`);
    return { value: value as RippleOutputV1, n };
  });
  const [first, ...rest] = parsed;
  if (first!.value.kind !== 'preflight') throw new AnswerError(`line ${first!.n} must be the preflight, which says the brief was read`);
  const pre = first!.value;
  if (pre.brief_sha256 !== brief.sha256) throw new AnswerError('the preflight names another version of the brief; read the brief again');
  const echo = plainText(pre.echo);
  if (echo.length < ECHO_MIN) throw new AnswerError(`the preflight's echo holds ${echo.length} characters, under ${ECHO_MIN}`);
  if (!plainText(brief.text).includes(echo)) throw new AnswerError('the preflight\'s echo is not the brief\'s words');
  if (plainText(packet).includes(echo)) throw new AnswerError('the preflight\'s echo is in the packet, so it does not show the brief was read');
  const proposals: Proposed[] = [];
  for (const { value, n } of rest) {
    if (value.kind === 'preflight') throw new AnswerError(`line ${n} is a second preflight`);
    proposals.push(value);
  }
  return { proposals };
}
