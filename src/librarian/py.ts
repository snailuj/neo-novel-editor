// Python string semantics the ported librarian depends on. Hoard's checks were written
// against CPython's str, re and difflib; where JavaScript's built-ins differ, the port
// calls these instead, so a finding falls on the same line and sorts in the same order.

// Every terminator str.splitlines() honours: \n, \r, \r\n, \v, \f, \x1c to \x1e, \x85,
// \u2028 and \u2029. Control characters are the point here.
// oxlint-disable-next-line no-control-regex
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g;

/** str.splitlines(keepends): no empty last line for a trailing terminator, [] for ''. */
export function splitlines(text: string, keepends = false): string[] {
  const out: string[] = [];
  let at = 0;
  for (const m of text.matchAll(LINE_BREAK)) {
    const end = m.index + m[0].length;
    out.push(text.slice(at, keepends ? end : m.index));
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// str.isspace() for one code point: Python counts \x1c to \x1f as whitespace and not
// \ufeff, which JavaScript's \s and trim() treat the other way round.
// oxlint-disable-next-line no-control-regex
const PY_SPACE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;

export function isPySpace(ch: string): boolean {
  return PY_SPACE.test(ch);
}

/** str.strip(chars): whitespace by Python's definition when chars is omitted. */
export function pyStrip(text: string, chars?: string): string {
  return pyRstrip(pyLstrip(text, chars), chars);
}

export function pyLstrip(text: string, chars?: string): string {
  const drop = stripTest(chars);
  const cps = Array.from(text);
  let i = 0;
  while (i < cps.length && drop(cps[i]!)) i++;
  return cps.slice(i).join('');
}

export function pyRstrip(text: string, chars?: string): string {
  const drop = stripTest(chars);
  const cps = Array.from(text);
  let j = cps.length;
  while (j > 0 && drop(cps[j - 1]!)) j--;
  return cps.slice(0, j).join('');
}

/** str.split() with no separator: runs of Python whitespace split, and no empty parts. */
export function pySplit(text: string): string[] {
  const parts: string[] = [];
  let word = '';
  for (const ch of text) {
    if (isPySpace(ch)) {
      if (word) parts.push(word);
      word = '';
    } else {
      word += ch;
    }
  }
  if (word) parts.push(word);
  return parts;
}

function stripTest(chars?: string): (ch: string) => boolean {
  if (chars === undefined) return isPySpace;
  const set = new Set(Array.from(chars));
  return (ch) => set.has(ch);
}

/**
 * str.casefold(), closely enough for the checks that use it (QV2, CS2). Upper then lower
 * folds ß to ss and ſ to s as casefold does; the rare code points it misses are not names
 * a vault holds.
 */
export function casefold(text: string): string {
  return text.toUpperCase().toLowerCase();
}

/** Python's string order: by code point, where JavaScript's sort compares UTF-16 units. */
export function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** len() of a str: code points, not UTF-16 units. */
export function pyLen(text: string): number {
  return Array.from(text).length;
}

/** text[:n] by code point. */
export function pySlice(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join('');
}

/**
 * difflib.SequenceMatcher(None, a, b).ratio(), over code points: 2 * matches / total
 * length, matches found by Ratcliff and Obershelp's recursive longest common block with
 * difflib's own tie-breaking and its autojunk rule for b of 200 or more elements.
 */
export function sequenceRatio(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const total = x.length + y.length;
  if (total === 0) return 1;
  return (2 * matchingTotal(x, y)) / total;
}

function matchingTotal(a: string[], b: string[]): number {
  const b2j = new Map<string, number[]>();
  b.forEach((ch, j) => {
    const list = b2j.get(ch);
    if (list) list.push(j);
    else b2j.set(ch, [j]);
  });
  // autojunk: in a b of 200 or more, an element making up more than 1% (plus one) of it
  // is popular and is dropped from b2j, as SequenceMatcher.__chain_b does.
  if (b.length >= 200) {
    const limit = Math.floor(b.length / 100) + 1;
    for (const [ch, list] of b2j) if (list.length > limit) b2j.delete(ch);
  }

  // find_longest_match without junk: the longest a[i:i+k] == b[j:j+k] in the ranges,
  // earliest i and then earliest j on a tie.
  const longest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    // difflib then widens the match over equal neighbours, which with no isjunk can only
    // be the popular elements autojunk left out of b2j.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  };

  let matches = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k === 0) continue;
    matches += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  return matches;
}

/**
 * str(value) as Python prints a value that PyYAML loaded, for findings that quote one
 * (FM4's "invalid type 'True'"). Lists and mappings print as Python's repr does.
 */
export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof PyDate) return value.toString();
  return pyRepr(value);
}

export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : pyFloat(value);
  if (typeof value === 'string') return reprString(value);
  if (value instanceof PyDate) return value.repr();
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`).join(', ')}}`;
  }
  return String(value);
}

function pyFloat(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf';
  const s = String(n);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

// repr(str): single quotes unless the text holds a single quote and no double one.
function reprString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch.codePointAt(0)! < 0x20 || ch.codePointAt(0) === 0x7f) {
      out += `\\x${ch.codePointAt(0)!.toString(16).padStart(2, '0')}`;
    } else out += ch;
  }
  return quote + out + quote;
}

/**
 * A YAML timestamp as PyYAML loads it: a date for `2026-10-15`, a datetime when a time
 * follows. Kept as text so it prints as Python prints it and never shifts by a time zone.
 */
export class PyDate {
  readonly text: string;
  constructor(text: string) {
    this.text = text.trim();
  }
  get isDate(): boolean {
    return /^\d{4}-\d{1,2}-\d{1,2}$/.test(this.text);
  }
  /** str(): ISO date, or date and time joined by a space as datetime prints. */
  toString(): string {
    if (this.isDate) {
      const [y, m, d] = this.text.split('-');
      return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
    }
    return this.text.replace(/[Tt]|[ \t]+/, ' ');
  }
  repr(): string {
    const [y, m, d] = this.toString().slice(0, 10).split('-').map(Number);
    return this.isDate ? `datetime.date(${y}, ${m}, ${d})` : `datetime.datetime(${this.text})`;
  }
}
