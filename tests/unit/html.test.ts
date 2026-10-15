// Rule: a chapter file's paragraphs read as the window's textContent reads them, so a
// place counted on the file is the same place on the page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphTexts } from '../../src/hoard/html.ts';

test('each <p> gives its text, tags dropped and entities read', () => {
  const html = '<p>One &amp; <em>two</em></p><p class="scene-break">***</p><p data-first="">A&nbsp;b&lt;c&gt; &#8217;d&#x2019;</p>';
  assert.deepEqual(paragraphTexts(html), ['One & two', '***', 'A b<c> ’d’']);
});

test('a <br> adds nothing, and an empty paragraph is empty', () => {
  assert.deepEqual(paragraphTexts('<p>a<br>b</p><p><br></p>'), ['ab', '']);
});

test('paragraphs inside a list or quotation count, in order; other blocks do not', () => {
  assert.deepEqual(paragraphTexts('<blockquote><p>q</p></blockquote><div>no</div><ul><li><p>l</p></li></ul><p>end</p>'), ['q', 'l', 'end']);
});

test('a tag name that starts with p is not a paragraph', () => {
  assert.deepEqual(paragraphTexts('<pre>x</pre><p>y</p><param>'), ['y']);
});
