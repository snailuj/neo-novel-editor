import { test, expect } from '@playwright/test';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Rule: a saved chapter file holds exactly the HTML upstream Neo would write
// for the same page. The reference is upstream's own captureBody and
// persistChapter, read from the upstream/main ref and run against the same
// body the fork's page holds.
const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const upstreamApp = execFileSync('git', ['show', 'upstream/main:app.js'], { cwd: appRoot, encoding: 'utf8', maxBuffer: 1 << 28 });
const between = (from, to) => {
  const at = upstreamApp.indexOf(from);
  if (at < 0) throw new Error('upstream/main app.js has no ' + from);
  return upstreamApp.slice(at, upstreamApp.indexOf(to, at));
};
const UPSTREAM_CAPTURE = between('function captureBody(', '// A chapter that opens on a line of dialogue');
const UPSTREAM_PERSIST = between('function persistChapter(', '// Another device\'s version of a chapter');

const CHAPTER = 'chapter-synthetic';
const chapterFile = (fixture, bookId) => path.join(fixture.profile, 'documents', 'NEO Library', bookId, 'chapters', CHAPTER + '.html');

const CASES = {
  'paragraphs and a scene break': '<p>Opening.</p><p class="scene-break">***</p><p>After the break.</p><p><br></p>',
  'nested lists': '<p>Opening.</p><ul><li>one<ul><li>nested<ol><li>deeper</li></ol></li></ul></li><li>two</li></ul><p>Closing.</p>',
  'a blockquote': '<p>Opening.</p><blockquote><p>Quoted.</p><p>Quoted again.</p></blockquote><p>Closing.</p>',
  'br in poetry': '<p>Opening.</p><p class="poetry">line one<br>line two<br>line three</p><p>Closing.</p>',
  'pre and code': '<p>Opening.</p><pre><code>first\n  second\n\nfourth</code></pre><p>Use <code>a\nb</code> here.</p><p>Closing.</p>',
  'non-ASCII text': '<p>Opening.</p><p>Māia &amp; A😀é, 日本語, ñandú, ½.</p><p>Closing.</p>',
  'a script heading and a div': '<p class="sp-heading">INT. ROOM - DAY</p><div>A div.</div><h2>A heading.</h2><p>Closing.</p>'
};

for (const [name, html] of Object.entries(CASES)) {
  test(`the file holds upstream's bytes: ${name}`, async () => {
    const fixture = await launchProfile();
    try {
      const bookId = await seedBook(fixture.page, html);
      const file = chapterFile(fixture, bookId);
      // type into the first paragraph, as the writer would, and save. The
      // reference runs upstream's two functions over the same body, in a
      // scope of their own so they see stand-ins for the page's state.
      const expected = await fixture.page.evaluate(`(async () => {
        const chId = ${JSON.stringify(CHAPTER)};
        const body = document.querySelector('.chapter[data-id="' + chId + '"] .chapter-body');
        body.querySelector('p').append(' Typed.');
        syncChapter(body, chId);
        const written = [];
        const upstream = (() => {
          const book = { id: 'b' };
          const savedHTML = {};
          const chapterHTML = {};
          const writing = {};
          const chapterChain = {};
          const diskKnown = {};
          const knowDisk = () => {};
          const keepOtherDeviceVersion = async () => {};
          const window = { neo: { writeChapter: async (bookId, id, text) => { written.push(text); return true; } } };
          ${UPSTREAM_CAPTURE}
          ${UPSTREAM_PERSIST}
          return { captureBody, persistChapter };
        })();
        await upstream.persistChapter(chId, upstream.captureBody(body));
        flushAllSaves();
        await Promise.all(Object.values(chapterChain));
        return written[0];
      })()`);
      expect(expected).toContain('Typed.');
      expect(await readFile(file, 'utf8')).toBe(expected);
    } finally { await fixture.close(); }
  });
}
