'use strict';

// A chapter file is compact HTML: no whitespace between the blocks. For
// git's diff, log, blame and merge it reads better one paragraph per line.
// paragraphLines puts one line break after each top-level block that a
// block or the end follows, and nothing else changes. compactLines takes
// those line breaks away again.
//
// Any other element (a list, a table, a section, a link) takes no line of
// its own, and the blocks it holds are part of it: the depth counts every
// element that has an end tag, so depth zero is the body.
//
// Both work on text, not a DOM, and only look at ASCII tags, so a file read
// as latin1 and written back as latin1 keeps every byte of its UTF-8.

const TAG = /<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi;
const LINED = /^(?:p|div|h[1-6]|blockquote)$/i;
const EMPTY = /^(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
const GAP = /[\t\n\f\r ]*/y;
const BLOCK = /<(?:p|div|h[1-6]|blockquote)\b/iy;

// Calls put(closeEnd, next) for each place where a line ends: `closeEnd` is
// the index just after a top-level block's end tag, `next` the index where
// the whitespace after it stops.
function eachLineEnd(html, put) {
  const tag = new RegExp(TAG.source, TAG.flags);
  let depth = 0;
  let m;
  while ((m = tag.exec(html))) {
    if (EMPTY.test(m[2])) continue;
    if (!m[1]) { depth++; continue; }
    depth = Math.max(0, depth - 1);
    if (depth || !LINED.test(m[2])) continue;
    const close = m.index + m[0].length;
    GAP.lastIndex = close;
    GAP.exec(html);
    const next = GAP.lastIndex;
    BLOCK.lastIndex = next;
    if (next !== html.length && !BLOCK.test(html)) continue;
    put(close, next);
    tag.lastIndex = next;
  }
}

function rebuild(html, between) {
  let out = '';
  let from = 0;
  eachLineEnd(html, (close, next) => {
    out += html.slice(from, close) + between;
    from = next;
  });
  return out + html.slice(from);
}

const paragraphLines = (html) => rebuild(html, '\n');
const compactLines = (html) => rebuild(html, '');

module.exports = { paragraphLines, compactLines };
