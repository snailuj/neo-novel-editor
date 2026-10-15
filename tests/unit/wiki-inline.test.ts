// Rule: a line's Markdown emphasis becomes NEO's own inline HTML (b, i, s, code) and
// leaves the words; anything that is not emphasis stays as written; and every place in
// the line as written maps to the same words in the text, so a mark lands where it was.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inline } from '../../src/hoard/wiki/inline.ts';

const html = (s: string) => inline(s).html;

test('bold, italic, both and strike become b, i and s', () => {
  assert.equal(html('a **b** c'), 'a <b>b</b> c');
  assert.equal(html('a __b__ c'), 'a <b>b</b> c');
  assert.equal(html('a *b* _c_'), 'a <i>b</i> <i>c</i>');
  assert.equal(html('***both***'), '<i><b>both</b></i>');
  assert.equal(html('**a *b* c**'), '<b>a <i>b</i> c</b>');
  assert.equal(html('~~gone~~ but ~not~'), '<s>gone</s> but ~not~');
});

test('what is not emphasis stays as written', () => {
  assert.equal(html('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(html('snake_case_name and f***'), 'snake_case_name and f***');
  assert.equal(html('**open only'), '**open only');
  assert.equal(html('**a* b'), '*<i>a</i> b');
});

test('code, links and escapes are kept whole, and nothing in them is emphasis', () => {
  assert.equal(html('use `a_b *c*` here'), 'use <code>a_b *c*</code> here');
  assert.equal(html('see [[Tide_Tables|the *tides*]]'), 'see [[Tide_Tables|the *tides*]]');
  assert.equal(html('a [b_c](https://x.org/a_b_c) d'), 'a [b_c](https://x.org/a_b_c) d');
  assert.equal(html('at https://x.org/a_b_c_ ok'), 'at https://x.org/a_b_c_ ok');
  assert.equal(html('\\*not\\* and \\\\'), '*not* and \\');
});

test('the text is what the page shows, and HTML in it is escaped', () => {
  const r = inline('A <b>tag</b> & **bold** `x<y`');
  assert.equal(r.text, 'A <b>tag</b> & bold x<y');
  assert.equal(r.html, 'A &lt;b&gt;tag&lt;/b&gt; &amp; <b>bold</b> <code>x&lt;y</code>');
});

test('each place in the line maps to the same words in the text', () => {
  const s = 'The **old** quay `x`';
  const r = inline(s);
  const span = (a: number, b: number) => r.text.slice(r.map[a], r.map[b]);
  assert.equal(span(s.indexOf('old'), s.indexOf('old') + 3), 'old');
  assert.equal(span(s.indexOf('**'), s.indexOf('quay')), 'old ');
  assert.equal(span(0, s.length), r.text);
  assert.equal(span(s.indexOf('x'), s.indexOf('x') + 1), 'x');
  assert.equal(r.map.length, s.length + 1);
  // a run's leftover letter is text where it stood
  assert.deepEqual(inline('**a* b').map, [0, 1, 1, 2, 2, 3, 4]);
  assert.deepEqual(inline('\\*a').map, [0, 0, 1, 2]);
});
