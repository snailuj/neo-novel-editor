// Ported from hoard's tests/test_quotes.py, names made up: does the quoted string
// actually appear in the cited page? A heading merged away left librarian pages quoting
// it as a receipt while every link still resolved; the link was fine and the quote was
// dead. Receipts into librarian prose rot, because librarian prose is what gets rewritten.
//
// Hoard committed each fixture vault to git so its ownership could be pinned to HEAD.
// HEAD equals the working text there, so pinned ownership equals the markers, which is
// what the port reads; the git setup is dropped. The command-line exit codes
// (test_cli_exit_codes, and the exit-code half of the QV2 test) are in cli.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureLogs } from '../../../src/librarian/log.ts';
import { byCodePoint } from '../../../src/librarian/py.ts';
import { checkVault, claims, fails, humanSpans, normalise } from '../../../src/librarian/quotes.ts';
import type { Note } from '../../../src/librarian/vault.ts';

const SOURCE = '---\ntype: source\nprovenance:\n  origin: o\n  method: converted\n'
  + '  author: the Long Read\n---\n'
  + 'It is a landscape of possibilities, a map of all the potential shapes.\n'
  + 'The pattern is primary, and the genome is just a message from your past self.\n';

function page(body: string): string {
  return '---\ntype: subject\nprovenance:\n  generator: claude-opus-5\n---\n'
    + `# X\n\n> [!librarian]- Agent-written page\n> r\n\n${body}`;
}

/** The notes as the vault reader hands them over: sorted by path. */
function vault(files: Record<string, string>): Note[] {
  return Object.entries(files).sort(([a], [b]) => byCodePoint(a, b));
}

function check(body: string, source: string = SOURCE): string[] {
  return checkVault(vault({ 'sources/orchards.md': source, 'lore/X.md': page(body) }));
}

test('inline quote present in the source is silent', () => {
  assert.deepEqual(check('It is "a map of all the potential shapes" ([[orchards]] -- the Long Read, one).\n'), []);
});

test('inline quote absent from the source is reported', () => {
  const findings = check('It is "a map of all the potential biscuits" ([[orchards]] -- the Long Read, one).\n');
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('QV1') && findings[0]!.includes('orchards'));
  assert.ok(findings[0]!.includes('a map of all the potential biscuits'));
});

// The vault's real shape: several quotes, then one citation owning them.
test('every quote before the citation belongs to it', () => {
  const findings = check('A "landscape of possibilities" that is also "a map of all the potential biscuits" '
    + '([[orchards]] -- the Long Read, one).\n');
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('biscuits'));
});

// Soft wrapping is how these pages are written; a checker that reads line by line
// reports the whole paragraph as missing.
test('a quote wrapped across lines is still one quote', () => {
  assert.deepEqual(check('It is "a map of all the\npotential shapes" ([[orchards]] -- the Long Read, one).\n'), []);
});

// Both attribution positions the vault uses: inside the blockquote, and on a line of
// its own after it.
test('block quote is checked against its attribution', () => {
  const inside = '> The pattern is primary, and the genome is just a message from\n'
    + '> your past self.\n>\n> -- [[orchards]] (the Long Read, one)\n';
  assert.deepEqual(check(inside), []);
  const outside = '> The pattern is primary, and the genome is just a biscuit.\n\n'
    + '-- [[orchards]] (the Long Read, one)\n';
  const findings = check(outside);
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('biscuit'));
});

// `…` and `...` mark cut text, so each side must appear, and in order, or a quote could
// be assembled from pieces the source never joined.
test('an elision is checked fragment by fragment in order', () => {
  assert.deepEqual(check('It is "a landscape of possibilities … the potential shapes" '
    + '([[orchards]] -- the Long Read, one).\n'), []);
  const backwards = check('It is "the potential shapes … a landscape of possibilities" '
    + '([[orchards]] -- the Long Read, one).\n');
  assert.equal(backwards.length, 1);
});

// A wrong capital is a fidelity defect but a different job from a dead receipt, and
// conflating them buries the dead ones.
test('a case difference is reported separately from a missing quote', () => {
  const findings = check('It is "A Map Of All The Potential Shapes" ([[orchards]] -- the Long Read, one).\n');
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('QV2'));
});

// Standard quotation practice: `[Wren's] first mission` and `tie[d]` are edits, and the
// bytes either side of the bracket must appear in the source, in order.
test('a bracketed insertion is an edit point not bytes', () => {
  assert.deepEqual(check('It is "[The orchard is] a landscape of possibilities" '
    + '([[orchards]] -- the Long Read, one).\n'), []);
  assert.deepEqual(check('The genome is "just a message from [her] past self" '
    + '([[orchards]] -- the Long Read, one).\n'), []);
  // an inflection change: `shape[s]` where the source has `shapes`
  assert.deepEqual(check('It is "a map of all the potential shape[s]" '
    + '([[orchards]] -- the Long Read, one).\n'), []);
  // the bracket does not launder a wrong word on either side
  assert.equal(check('It is "a map of all the [potential] biscuits" '
    + '([[orchards]] -- the Long Read, one).\n').length, 1);
});

// Adapting a leading capital to the sentence is legitimate. The finding is still printed
// so a reader can see it, but a vault whose only findings are QV2 is green.
test('qv2 is informational and does not fail the check', () => {
  const findings = checkVault(vault({
    'sources/orchards.md': SOURCE,
    'lore/X.md': page('"A map of all the potential shapes" is how it goes ([[orchards]] -- the Long Read, one).\n'),
  }));
  assert.ok(findings.some((f) => f.includes('QV2')));
  assert.equal(fails(findings), false);
});

test('markdown emphasis is formatting not bytes', () => {
  assert.deepEqual(check('It is "a map of *all* the potential shapes" ([[orchards]] -- the Long Read, one).\n'), []);
});

test('dashes and curly quotes normalise', () => {
  const source = SOURCE.replace('The pattern is primary,', 'The pattern—it’s primary—');
  const body = 'It says "The pattern -- it\'s primary --" ([[orchards]] -- the Long Read, one).\n';
  assert.deepEqual(check(body, source), []);
});

// The source writes `child of [[Path - Harbour Gate#Harbour Gate|Harbour Gate]]` and the
// page quotes what that renders as. Markup is not a changed word.
test('a wikilink in the source matches its display text', () => {
  const source = `${SOURCE}He is child of [[Path - Harbour Gate#Harbour Gate|Harbour Gate]].\n`;
  assert.deepEqual(check('He is "child of Harbour Gate" ([[orchards]] -- the Long Read, one).\n', source), []);
});

// Poetry quoted inline carries ` / ` where the source has a newline.
test('verse line breaks rendered as slashes', () => {
  const source = `${SOURCE}then decelerate\ninto isolation\ndescend\n`;
  assert.deepEqual(check('It reads "then decelerate / into isolation / descend" '
    + '([[orchards]] -- the Long Read, one).\n', source), []);
});

// From a real lore page: `rendered by the ASR as "Gc" and "G. C."; the exact phrase ...`.
// Skipping the short span during matching paired the wrong marks and invented quotations
// from the prose between them.
test('a two letter quote does not shift the pairing', () => {
  const source = `${SOURCE}The ASR renders it "Gc" and "G. C." throughout.\n`;
  const body = 'The ASR renders it "Gc" and "G. C."; a "map of all the potential shapes" '
    + '([[orchards]] -- the Long Read, one).\n';
  assert.deepEqual(check(body, source), []);
});

// Only librarian pages carry receipts. Author bytes are his, quotes and all, and a
// `> [!human]` span inside a librarian page is equally untouchable.
test('author bodies and human spans are not checked', () => {
  const notes = vault({
    'sources/orchards.md': SOURCE,
    'writing/path/a.md': 'He wrote "a map of all the potential biscuits" ([[orchards]] -- the Long Read, one).\n',
    'lore/X.md': page('> [!human]\n\nMy own note quoting "a map of all the potential biscuits" '
      + '([[orchards]] -- the Long Read, one).\n'),
  });
  // The span quote sits in a paragraph, not a blockquote, so the marker is what keeps it
  // from being checked: with the marker removed this is QV1.
  assert.deepEqual(checkVault(notes), []);
});

// Obsidian reads callout types case-insensitively, so `> [!Human]` opens an author span
// exactly as `> [!human]` does, and its bytes carry no librarian receipt.
test('a capitalised human span is not checked', () => {
  assert.deepEqual(checkVault(vault({
    'sources/orchards.md': SOURCE,
    'lore/X.md': page('> [!Human]\n\nMy own note quoting "a map of all the potential biscuits" '
      + '([[orchards]] -- the Long Read, one).\n'),
  })), []);
});

// `> [!Librarian]` hands the page back, so a dead receipt after it is checked.
test('a capitalised librarian marker closes the span', () => {
  const findings = checkVault(vault({
    'sources/orchards.md': SOURCE,
    'lore/X.md': page('> [!human]\n\nHis own note.\n\n> [!Librarian]\n\n'
      + 'It is "a map of all the potential biscuits" ([[orchards]] -- the Long Read, one).\n'),
  }));
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('QV1'));
});

// `-- Morrow, "My Summary"` names a position in the source; it is not text claimed to be
// IN the source. Reading it as one also swallowed the citation, so every quote it owned
// went unchecked.
test('a quoted locator is not a quotation', () => {
  const body = 'It is "a map of all the potential shapes" ([[orchards]] -- the Long '
    + 'Read, quoted under "A Heading That Is Not In The Source").\n';
  assert.deepEqual(check(body), []);
});

// The regression the locator bug caused: the citation was consumed, so the NEXT quote in
// the paragraph lost its owner and was never verified.
test('a quote after a citation that carries a locator is still checked', () => {
  const body = 'One "a map of all the potential shapes" ([[orchards]] -- the Long '
    + 'Read, under "Some Heading"); two "a map of all the potential '
    + 'biscuits" ([[orchards]] -- the Long Read, one).\n';
  const findings = check(body);
  assert.equal(findings.length, 1, String(findings));
  assert.ok(findings[0]!.includes('biscuits'));
});

// From a real project page. The footer citation owns what is LEFT OVER, not everything
// after it: a quote that a later inline citation claims belongs to that citation.
test('a later citation beats the footer that opened the bullet', () => {
  const other = '---\ntype: source\nprovenance:\n  origin: o\n  method: converted\n'
    + '  author: Morrow\n---\nSection: QRT Round 1 - Runaway.\n';
  assert.deepEqual(checkVault(vault({
    'sources/orchards.md': SOURCE, 'sources/ledger.md': other,
    'lore/X.md': page('- [[orchards]] (the Long Read) -- the "potential shapes" '
      + 'draft, from the "QRT Round 1 - Runaway" section ([[ledger]] -- Morrow, Revision)\n'),
  })), []);
});

// The real shape: a long footer bullet that cites a second page mid-way and then goes on
// quoting ITS OWN earlier material. Pushing those trailing quotes back onto the bullet's
// own citation invents defects.
test('a quote trailing past the last citation is unowned', () => {
  const other = '---\ntype: source\nprovenance:\n  origin: o\n  method: converted\n'
    + '  author: Morrow\n---\nFeedback: significant changes from submission.\n';
  assert.deepEqual(checkVault(vault({
    'sources/orchards.md': SOURCE, 'sources/ledger.md': other,
    'lore/X.md': page('- [[orchards]] (the Long Read) -- named in the line '
      + '([[ledger]] -- Morrow, Revision), and evidence of the '
      + '"significant changes from submission".\n'),
  })), []);
});

test('a dangling or unresolved citation is not a quote finding', () => {
  assert.deepEqual(check('It says "whatever it likes" ([[no-such-page]] -- someone, one).\n'), []);
});

// --- self-citations: a chimera page quoting its own [!human] span ---
//
// The whole page trivially contains any quote its own claiming line carries, so a
// self-receipt checked against the full page would be vacuously green. It is checked
// against the page's `> [!human]` spans only, the bytes it vouches for.

function chimera(librarianProse: string, humanSpan: string): string {
  return '---\ntype: lore\nsetting: ash\naliases:\n- brisa\n'
    + 'provenance:\n  generator: claude-opus-5\n  author: librarian, Morrow\n---\n'
    + '# X\n\n> [!librarian]- Agent-written page\n> r\n\n'
    + `${librarianProse}\n\n> [!human] Character sheet\n\n${humanSpan}\n`;
}

function checkSelf(librarianProse: string, humanSpan: string): string[] {
  return checkVault(vault({ 'lore/X.md': chimera(librarianProse, humanSpan) }));
}

test('self citation verifies against the human span', () => {
  assert.deepEqual(checkSelf('She is a "young keeper of bones" ([[X]] -- Morrow, sheet).',
    'A young keeper of bones in the Heron crypts.'), []);
});

test('self citation verifies against a capitalised human span', () => {
  const text = chimera('She is a "young keeper of bones" ([[X]] -- Morrow, sheet).',
    'A young keeper of bones in the Heron crypts.').replace('> [!human] Character sheet', '> [!Human] Character sheet');
  assert.deepEqual(checkVault(vault({ 'lore/X.md': text })), []);
});

test('human spans honour capitalised markers', () => {
  const span = humanSpans('> [!HUMAN]\nHis own prose.\n> [!Librarian]- back\nLibrarian prose.\n');
  assert.ok(span.includes('His own prose'));
  assert.ok(!span.includes('Librarian prose'));
});

// Four spaces of indent make a code block, not a callout, so the shared marker pattern
// must see the raw line. Matching a stripped line opened a span here.
test('a marker indented four spaces opens no span', () => {
  const span = humanSpans('    > [!human]\nLibrarian prose.\n> [!human]\nHis own prose.\n'
    + '    > [!librarian]\nStill his.\n');
  assert.ok(!span.includes('Librarian prose'));
  assert.ok(span.includes('His own prose') && span.includes('Still his'));
});

// An indented pseudo-marker is a code block, so the paragraph after it is librarian
// prose and its dead receipt is reported.
test('a receipt under a four space indented marker is checked', () => {
  const findings = checkVault(vault({
    'sources/orchards.md': SOURCE,
    'lore/X.md': page('    > [!human]\n\nMy own note quoting "a map of all the potential biscuits" '
      + '([[orchards]] -- the Long Read, one).\n'),
  }));
  assert.ok(findings.some((f) => f.includes('QV1')));
});

test('self citation not in span is reported not vacuously green', () => {
  const findings = checkSelf('She is a "young keeper of bones" ([[X]] -- Morrow, sheet).',
    'A quiet archivist of the crypts.');
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('QV1') && findings[0]!.includes('young keeper of bones'));
});

test('self citation case slip is qv2', () => {
  const findings = checkSelf('She is a "Young Keeper of Bones" ([[X]] -- Morrow, sheet).',
    'A young keeper of bones in the Heron crypts.');
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('QV2'));
});

test('self citation through an alias is still self', () => {
  const findings = checkSelf('She is a "young keeper of bones" ([[brisa]] -- Morrow, sheet).',
    'A quiet archivist of the crypts.');
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('QV1'));
});

test('self citation with no human span is dead', () => {
  const text = '---\ntype: lore\nsetting: ash\nprovenance:\n  generator: claude-opus-5\n---\n'
    + '# X\n\n> [!librarian]- Agent-written page\n> r\n\n'
    + 'She is a "young keeper of bones" ([[X]] -- Morrow, sheet).\n';
  const findings = checkVault(vault({ 'lore/X.md': text }));
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('QV1'));
});

const BLOCKQUOTE_SOURCE = '---\ntype: source\nprovenance:\n  origin: o\n  method: converted\n'
  + '  author: the Long Read\n---\n'
  + '> The pattern is primary, and the genome is just a message\n'
  + '> from your past self.\n';

// The cited page often carries the words inside a blockquote, and Obsidian puts a `>` on
// EVERY line of one. The markers came off the needle but not off the haystack, so any
// quotation spanning a line break was a false QV1.
test('a blockquote in the cited page matches across its markers', () => {
  assert.deepEqual(check('It is "a message from your past self" ([[orchards]] -- the Long Read, one).\n',
    BLOCKQUOTE_SOURCE), []);
});

// `2009\.` is how a markdown source stops `2009.` opening an ordered list. The backslash
// is typography, like the emphasis markers beside it. Bare `*` is itself stripped as
// emphasis, so the escaped form is compared against the bare one.
test('markdown backslash escapes resolve to the bare character', () => {
  assert.equal(normalise(String.raw`2009\. First`), '2009. First');
  assert.equal(normalise(String.raw`a\_b`), 'a_b');
  assert.equal(normalise(String.raw`a\#b`), 'a#b');
  assert.equal(normalise(String.raw`a\[b`), 'a[b');
  assert.equal(normalise(String.raw`a\*b`), normalise('a*b'));
});

test('an escaped full stop in the source still matches its quotation', () => {
  const source = `${SOURCE}Harbour Station, 14th July 2009\\.  \nFirst edit Porthaven\n`;
  const body = 'The colophon reads "14th July 2009. First edit Porthaven" ([[orchards]] -- the Long Read, one).\n';
  assert.deepEqual(check(body, source), []);
});

test('normalise renders a table escaped pipe link as its display', () => {
  assert.equal(normalise(String.raw`see [[the-boathouse\|Path - The Boathouse]] now`),
    normalise('see Path - The Boathouse now'));
});

// `~~~` fences are documentation for quotes as ``` fences are.
test('a quote inside a tilde fence is documentation', () => {
  assert.deepEqual(check('~~~\n"not in the source" ([[orchards]] -- the Long Read, one)\n~~~\n'), []);
});

const BAD = '---\ntype: lore\nsetting: x\n: : :\n---\nno receipt here\n';

// The no-swallow rule: skipping a librarian page whose frontmatter will not parse must
// log the skip.
test('malformed frontmatter skip in check vault logs', () => {
  const { records } = captureLogs(() => checkVault(vault({ 'lore/x.md': page('q\n'), 'lore/bad.md': BAD })));
  assert.ok(records.some((r) => r.logger === 'librarian.quotes' && r.level === 'error'
    && r.message.includes('skipped') && r.message.includes('lore/bad.md')), JSON.stringify(records));
});

// The skip drops that page's receipts from the run, so it must not read as a clean page:
// QV3, and QV3 fails the check (QV2 alone is informational).
test('malformed frontmatter skip is a failing qv3 finding', () => {
  const findings = checkVault(vault({ 'lore/x.md': page('q\n'), 'lore/bad.md': BAD }));
  assert.ok(findings.some((f) => f.includes(' QV3 ') && f.includes('lore/bad.md')), String(findings));
  assert.equal(fails(findings), true);
});

// --- Track Changes: a receipt whose source carries a pending mark still resolves ---
// `contains` is run against the source read BOTH ways, so a receipt stands whether the
// mark is about to be accepted or rejected.

const markedSource = (line: string) => '---\ntype: source\nprovenance:\n  origin: o\n  method: converted\n'
  + `  author: the Long Read\n---\n${line}\n`;

test('quote split by a deletion in the source still resolves', () => {
  assert.deepEqual(check('It is "a landscape of possibilities" ([[orchards]] -- the Long Read, one).\n',
    markedSource('It is a landscape{-- of many--} of possibilities.')), []);
});

test('quote split by an insertion in the source still resolves', () => {
  assert.deepEqual(check('It is "a landscape of possibilities" ([[orchards]] -- the Long Read, one).\n',
    markedSource('It is a landscape{++ of many++} of possibilities.')), []);
});

test('quote matching only the accepted reading resolves', () => {
  assert.deepEqual(check('It is "a terrain of possibilities" ([[orchards]] -- the Long Read, one).\n',
    markedSource('It is a {~~landscape~>terrain~~} of possibilities.')), []);
});

test('a receipt matching neither reading is still qv1', () => {
  const findings = check('It is "a seascape of possibilities" ([[orchards]] -- the Long Read, one).\n',
    markedSource('It is a {~~landscape~>terrain~~} of possibilities.'));
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('QV1'));
});

test('the finding names which reading was tried', () => {
  const findings = check('It is "a seascape of possibilities" ([[orchards]] -- the Long Read, one).\n',
    markedSource('It is a {~~landscape~>terrain~~} of possibilities.'));
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('accepted or rejected'));
});

// `author="Claude"` inside a mark would otherwise read as a quoted string and, worse,
// leave its quote marks unpaired, skewing every quotation after it on the page.
test('an attribute prefix does not become a quotation', () => {
  const body = 'A claim{author="Claude"++ proposed++} then "a map of all the potential shapes" '
    + '([[orchards]] -- the Long Read, one).\n';
  assert.deepEqual(check(body), []);
});

test('human spans keep a deletion and drop an insertion', () => {
  const span = humanSpans('> [!human]\nHis own prose{-- as it stands--}{++ and a proposal++}.\n> [!librarian]- back\n');
  assert.ok(span.includes('as it stands'));
  assert.ok(!span.includes('and a proposal'));
});

// An insertion inside a `> [!human]` span is a proposal, not author prose, so a receipt
// vouching for it as the author's standing text is dead.
test('a self receipt quoting a proposal into author bytes is qv1', () => {
  const body = '> [!human]\nHis own prose{++ and a proposal++}.\n> [!librarian]- back\n\n'
    + 'The page says "and a proposal" ([[X]] -- Morrow, span).\n';
  assert.ok(check(body).some((f) => f.includes('QV1')));
});

// Two candidate target pages give two haystacks without any mark being involved, so the
// readings are named per PAGE, not per haystack.
test('a mark free qv1 does not claim two readings were tried', () => {
  const findings = check('- [[orchards]] (the Long Read) -- a note quoting '
    + '"words the source never carried" ([[orchards]] -- the Long Read, two).\n');
  assert.ok(findings.some((f) => f.includes('QV1')));
  assert.ok(!findings.some((f) => f.includes('accepted or rejected')));
});

// --- the port's own cases ---

// A finding names the file line, frontmatter included, and keeps hoard's wording.
test('a finding names the file line and keeps the wording', () => {
  assert.deepEqual(check('It is "a map of all the potential biscuits" ([[orchards]] -- the Long Read, one).\n'), [
    'lore/X.md:11: QV1 quotation not found in [[orchards]]: "a map of all the potential biscuits"',
  ]);
});

// Python's len() counts code points: an excerpt of 70 astral characters is whole, and a
// longer one is cut at 67 of them, never inside a surrogate pair.
test('the excerpt is cut at 70 code points', () => {
  const whole = '\u{1F332}'.repeat(70);
  const [kept] = check(`It is "${whole}" ([[orchards]] -- the Long Read, one).\n`);
  assert.ok(kept!.endsWith(`"${whole}"`), kept);
  const [cut] = check(`It is "${whole}x" ([[orchards]] -- the Long Read, one).\n`);
  assert.ok(cut!.endsWith(`"${'\u{1F332}'.repeat(67)}..."`), cut);
});

// Line ownership arrives as an argument. Hoard proved it from git; the default reads the
// `> [!human]` markers, and a caller that knows more can pass its own.
test('protected lines from the caller keep a paragraph out of the check', () => {
  const notes = vault({
    'sources/orchards.md': SOURCE,
    'lore/X.md': page('It is "a map of all the potential biscuits" ([[orchards]] -- the Long Read, one).\n'),
  });
  assert.equal(checkVault(notes).length, 1);
  const owned = (relpath: string) => new Set(relpath === 'lore/X.md' ? [11] : []);
  assert.deepEqual(checkVault(notes, { protectedLines: owned }), []);
});

test('claims pair each quote with the citation that follows it', () => {
  assert.deepEqual(claims('A "first one" and "second one" ([[a]] -- S, x) then "third one" ([[b]] -- S, y).\n'), [
    { lineno: 1, text: 'first one', targets: ['a'] },
    { lineno: 1, text: 'second one', targets: ['a'] },
    { lineno: 1, text: 'third one', targets: ['b'] },
  ]);
});

test('the log counts the claims checked', () => {
  const { records } = captureLogs(() => check('It is "a map of all the potential shapes" ([[orchards]] -- the Long Read, one).\n'));
  assert.deepEqual(records.filter((r) => r.logger === 'librarian.quotes'), [
    { logger: 'librarian.quotes', level: 'info', message: 'quotes: 1 claim(s) checked, 0 finding(s)' },
  ]);
});
