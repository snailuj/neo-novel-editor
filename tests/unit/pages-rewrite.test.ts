// Rules: rewriting a link changes its target and nothing else (alias, anchor, spacing and
// markup stay byte for byte); it touches only the links the caller says resolve to the
// renamed page; code spans and code paragraphs are never touched; and the edits handed to
// the window, applied to the paragraphs' text, give the text of the rewritten file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphTexts, textOf } from '../../src/hoard/html.ts';
import { applyToText, editsFor, rewriteHtml, textUnits } from '../../src/hoard/pages/rewrite.ts';
import { key } from '../../src/librarian/links.ts';

const toNew = (target: string) => (key(target) === 'old' ? 'New' : null);
const run = (html: string) => rewriteHtml(html, toNew);

test('every form of a link keeps its alias and anchor and takes the new title', () => {
  const html = '<p>[[Old]] [[Old|shown]] [[Old#^abc123]] [[Old#Some Heading]] [[Old#^abc|shown]] ![[Old]]</p>';
  const out = run(html);
  assert.equal(out.html, '<p>[[New]] [[New|shown]] [[New#^abc123]] [[New#Some Heading]] [[New#^abc|shown]] ![[New]]</p>');
  assert.equal(out.rewritten, 6);
  assert.equal(out.skipped, 0);
});

test('a link is found as links fold: case, a folder path, .md and spaces inside the brackets', () => {
  const out = run('<p>[[old]] [[People/Old]] [[ OLD.md ]] [[Old \\|shown]]</p>');
  assert.equal(out.html, '<p>[[New]] [[New]] [[ New ]] [[New \\|shown]]</p>');
});

test('only the links the caller says resolve to the page change', () => {
  const html = '<p>[[Older]] [[Old Town]] [[Other|Old]] Old [[Old]] [[Old</p>';
  assert.equal(run(html).html, '<p>[[Older]] [[Old Town]] [[Other|Old]] Old [[New]] [[Old</p>');
  assert.equal(rewriteHtml(html, () => null).html, html);
});

test('inline code and code paragraphs are not rewritten', () => {
  const html = '<p>`[[Old]]` then [[Old]]</p><p class="wiki-code">[[Old]]</p><p class="x wiki-code y">[[Old]]</p><p>[[Old]]</p>';
  const out = run(html);
  assert.equal(out.html, '<p>`[[Old]]` then [[New]]</p><p class="wiki-code">[[Old]]</p><p class="x wiki-code y">[[Old]]</p><p>[[New]]</p>');
  assert.equal(out.rewritten, 2);
});

test('markup around and inside a link is kept, and a target split by markup is left and counted', () => {
  const out = run('<p>See <i>this</i> [[Old|<b>bold</b> text]] and [[Ol<b>d</b>]] and [[<b>Old</b>]] <a href="x">[[Old]]</a></p>');
  assert.equal(out.html, '<p>See <i>this</i> [[New|<b>bold</b> text]] and [[Ol<b>d</b>]] and [[<b>New</b>]] <a href="x">[[New]]</a></p>');
  assert.equal(out.rewritten, 3);
  assert.equal(out.skipped, 1);
});

test('entities in a title are read, and a new title is written escaped', () => {
  const out = rewriteHtml('<p>[[A &amp; B]] [[A &amp; B|x]]</p>', (t) => (key(t) === 'a & b' ? 'C <&> D' : null));
  assert.equal(out.html, '<p>[[C &lt;&amp;&gt; D]] [[C &lt;&amp;&gt; D|x]]</p>');
});

test('a file with no link to rewrite comes back as the same string', () => {
  const html = '<p>No links here.</p><p>[[Elsewhere]]</p>';
  assert.equal(run(html).html, html);
  assert.equal(run(html).rewritten, 0);
});

test('text units map to the html as textOf reads it, entities and surrogate pairs included', () => {
  for (const inner of ['plain', 'a &amp; b &lt;i&gt; &nbsp;x', 'smile &#128512; &#x1F600; end', '<i>a</i>&unknown; &amp', 'one<br>two']) {
    assert.equal(textUnits(inner).text, textOf(inner), inner);
  }
});

test('the edits handed to the window, applied to the paragraphs\' text, give the text of the rewritten file', () => {
  const html = [
    '<p>[[Old]] and [[Old|an alias]] and [[Elsewhere]]</p>',
    '<p class="wiki-code">[[Old]]</p>',
    '<p>Café &amp; <b>bold</b> [[old#^b1]] ![[People/Old.md]] `[[Old]]` [[Old]]</p>',
    '<p>smile &#128512; [[Old#Head|x]]</p>',
  ].join('');
  const edits = editsFor(html, toNew);
  assert.deepEqual(edits.map((e) => e.pIdx), [0, 0, 2, 2, 2, 3]);
  const texts = paragraphTexts(html);
  for (const e of edits) assert.equal(texts[e.pIdx]!.slice(e.off, e.off + e.len), e.expected);
  const after = applyToText(texts, edits);
  assert.deepEqual(after, paragraphTexts(run(html).html));
  assert.ok(edits.every((e) => e.replacement.includes('[[') && !/[\r\n]/.test(e.replacement)));
});
