// Ported from hoard's tests/test_lint.py: the metadata scheme and voice rules, enforced
// on the librarian zone and nowhere else. Names are made up; the speakers and roles come
// from a test scheme, as a library's own would. Not ported: the widened, informational
// BD3 scope over infra docs, skills and the rulebook (decision Widened-BD3-Stays-In-Hoard),
// and the walk's fixture-tree and attachment tests, which are vault-fs's (cli.test.ts).
// The PageIndex tests are in page-index.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CheckOptions, asAccepted, checkAliasLinks, checkNote, checkSpeakerLadder, checkVault, fails, humanSpanLines,
} from '../../../src/librarian/lint.ts';
import { captureLogs } from '../../../src/librarian/log.ts';
import { PageIndex } from '../../../src/librarian/page-index.ts';
import { DEFAULT_SCHEME, HOARD_LAYOUT, type Scheme } from '../../../src/librarian/scheme.ts';
import { byPathParts, zoneOf } from '../../../src/librarian/vault.ts';

const SCHEME: Scheme = { ...DEFAULT_SCHEME, roles: ['writer', 'gardener'], authorSpeaker: 'Mara' };

function check(relpath: string, text: string, index?: PageIndex, options: Partial<CheckOptions> = {}): string[] {
  return checkNote(relpath, text, { index, scheme: SCHEME, ...options });
}

function vault(files: Record<string, string>, logText = ''): string[] {
  const notes = Object.entries(files).sort(([a], [b]) => byPathParts(a, b));
  return checkVault(notes, { scheme: SCHEME, logText });
}

function index(pages: Record<string, string>): PageIndex {
  return PageIndex.fromNotes(Object.entries(pages));
}

const has = (findings: string[], ...parts: string[]) => findings.some((f) => parts.every((p) => f.includes(p)));
const only = (findings: string[], code: string) => findings.filter((f) => f.includes(code));

// --- frontmatter scheme -------------------------------------------------------

const GOOD = '---\ntype: writing\nproject: path\ndraft_status: downdraft\n'
  + 'role: [writer]\ntopics: ["[[the-boathouse]]"]\n'
  + 'provenance:\n  origin: old-vault/Writing/Path/x.md\n  ingested: 2026-07-18\n  method: verbatim\n---\nProse.\n';

test('a clean note yields no findings', () => {
  assert.deepEqual(check('writing/path/x.md', GOOD), []);
});

test('missing frontmatter is FM1', () => {
  assert.ok(has(check('writing/x.md', 'No metadata here.\n'), 'FM1'));
});

test('malformed YAML is FM2', () => {
  assert.ok(has(check('lore/x.md', '---\n: : :\n---\nbody\n'), 'FM2'));
});

test('an unknown key is FM3', () => {
  assert.ok(has(check('lore/x.md', '---\ntype: meta\nflavour: chocolate\n---\n'), 'FM3', 'flavour'));
});

test('unknown keys are reported in code point order', () => {
  const findings = only(check('lore/x.md', '---\ntype: meta\nzeta: 1\nBeta: 2\nalpha: 3\n---\n'), 'FM3');
  assert.deepEqual(findings, ["lore/x.md: FM3 unknown key 'Beta'", "lore/x.md: FM3 unknown key 'alpha'",
    "lore/x.md: FM3 unknown key 'zeta'"]);
});

test('an invalid type is FM4 and a missing one FM6', () => {
  assert.ok(has(check('lore/x.md', '---\ntype: banana\n---\n'), "FM4 invalid type 'banana'"));
  assert.ok(has(check('lore/x.md', "---\nproject: p\n---\n"), "FM6 'type' missing"));
});

// The value is quoted as Python prints it, so a YAML 1.1 boolean reads as True.
test('a non-string type is quoted as Python prints it', () => {
  assert.ok(has(check('lore/x.md', '---\ntype: yes\n---\n'), "FM4 invalid type 'True'"));
});

test('an invalid draft_status is FM5 and evergreen is fine', () => {
  const bad = '---\ntype: writing\ndraft_status: canon\nprovenance:\n  origin: o\n---\n';
  assert.ok(has(check('writing/x.md', bad), 'FM5'));
  assert.ok(!has(check('lore/x.md', '---\ntype: lore\ndraft_status: evergreen\n---\n'), 'FM5'));
});

test('a role outside the scheme is FM7', () => {
  assert.ok(has(check('lore/x.md', '---\ntype: meta\nrole: [wizard]\n---\n'), "FM7 invalid role 'wizard'"));
  assert.ok(!has(check('lore/x.md', '---\ntype: meta\nrole: gardener\n---\n'), 'FM7'));
});

test('the roles are the scheme\'s own', () => {
  const doc = '---\ntype: meta\nrole: [gardener]\n---\n';
  assert.ok(has(checkNote('lore/x.md', doc, { scheme: DEFAULT_SCHEME }), 'FM7'));
});

test('stage outside a project page is FM8', () => {
  assert.ok(has(check('writing/x.md', '---\ntype: writing\nstage: baby\nprovenance:\n  origin: o\n---\n'), 'FM8'));
  assert.ok(!has(check('projects/p.md', '---\ntype: project\nstage: baby\n---\n'), 'FM8'));
});

test('an invalid stage value is FM9', () => {
  assert.ok(has(check('projects/p.md', '---\ntype: project\nstage: banana\n---\n'), 'FM9'));
});

test('a source without provenance is PR1', () => {
  assert.ok(has(check('sources/a.md', '---\ntype: source\n---\nBody.\n'), 'PR1'));
});

test('an invalid provenance method is PR2', () => {
  assert.ok(has(check('sources/a.md', '---\ntype: source\nprovenance:\n  origin: o\n  method: teleported\n---\n'), 'PR2'));
});

test('the inbox is fully exempt', () => {
  assert.deepEqual(check('inbox/scrap.md', 'bare thought, no metadata\n'), []);
});

test('an inline Dataview field is BD1, on librarian-authored pages only', () => {
  assert.ok(has(check('projects/p.md', '---\ntype: meta\n---\nRole:: #writer\n'), 'BD1'));
  assert.deepEqual(check('_tasks/backlog.md', 'Role:: #writer\n'), []);
  const verbatim = '---\ntype: writing\nprovenance:\n  origin: o\n  method: verbatim\n---\n'
    + "Type:: legacy field inside the author's verbatim body\n";
  assert.ok(!has(check('writing/x.md', verbatim), 'BD1'));
});

test('a path-encoding sign in a filename is FN1', () => {
  assert.ok(has(check('writing/x∏y.md', '---\ntype: writing\nprovenance:\n  origin: o\n---\n'), 'FN1'));
});

test('the vault pass aggregates and leaves the as-is zone alone', () => {
  const findings = vault({ 'lore/bad.md': 'no fm\n', 'Daily/d.md': 'Habit:: done\n' });
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('FM1'));
});

const LIBRARIAN_PAGE = '---\ntype: lore\nprovenance:\n  generator: claude-fable-5\n---\n'
  + "# Kell'a\n\n> [!librarian]- Agent-written page\n> Receipts below.\n\nMy protagonist.\n";

test('a librarian page needs a generator (AT1)', () => {
  const doc = '---\ntype: lore\n---\n# X\n\n> [!librarian]- Agent-written page\n> r\n\nProse.\n';
  assert.ok(has(check('lore/X.md', doc), 'AT1'));
  assert.ok(!has(check('lore/X.md', LIBRARIAN_PAGE), 'AT1'));
});

// generator marks agent-authored content; on a verbatim author body it would be a lie
// about who wrote the prose.
test('an author body must not claim a generator (AT2)', () => {
  const doc = '---\ntype: writing\nprovenance:\n  origin: o\n  method: verbatim\n'
    + "  generator: claude-fable-5\n---\nThe author's prose.\n";
  assert.ok(has(check('writing/poetry/x.md', doc), 'AT2'));
  assert.ok(!has(check('lore/X.md', LIBRARIAN_PAGE), 'AT2'));
});

test('a librarian page needs the opening callout (AT3)', () => {
  const missing = '---\ntype: project\nprovenance:\n  generator: claude-fable-5\n---\n# Poetry\n\nRegistry page for my poems.\n';
  assert.ok(has(check('projects/poetry.md', missing), 'AT3'));
  assert.ok(!has(check('lore/X.md', LIBRARIAN_PAGE), 'AT3'));
});

test('the opening callout may follow an H1 and blank lines (AT3)', () => {
  const noH1 = '---\ntype: lore\nprovenance:\n  generator: claude-fable-5\n---\n\n'
    + '> [!librarian]- Agent-written page\n> Receipts below.\n\nProse.\n';
  assert.ok(!has(check('lore/X.md', noH1), 'AT3'));
});

// `subject` is what the work is about; `lore` is what exists inside the world.
test('subject is a valid type (FM4)', () => {
  const doc = '---\ntype: subject\nprovenance:\n  generator: claude-fable-5\n---\n'
    + '# Agency\n\n> [!librarian]- Agent-written page\n> r\n\nA theme.\n';
  assert.ok(!has(check('lore/Agency.md', doc), 'FM4'));
});

// A page inside the world belongs to an era.
test('lore requires a setting (FM10)', () => {
  const without = '---\ntype: lore\nprovenance:\n  generator: claude-fable-5\n---\n'
    + '# X\n\n> [!librarian]- Agent-written page\n> r\n\nProse.\n';
  assert.ok(has(check('lore/X.md', without), 'FM10'));
  assert.ok(!has(check('lore/X.md', without.replace('type: lore\n', 'type: lore\nsetting: odr/path\n')), 'FM10'));
});

test('a subject needs no setting (FM10)', () => {
  const doc = '---\ntype: subject\nprovenance:\n  generator: claude-fable-5\n---\n'
    + '# Emergence\n\n> [!librarian]- Agent-written page\n> r\n\nProse.\n';
  assert.ok(!has(check('lore/Emergence.md', doc), 'FM10'));
});

// The attribution callout is chrome, so it opens collapsed; the one exception is the
// ruled one-line title with no body.
test('the callout must start collapsed (AT3)', () => {
  const expanded = '---\ntype: lore\nprovenance:\n  generator: claude-fable-5\n---\n'
    + '# X\n\n> [!librarian] Agent-written page\n> r\n\nProse.\n';
  assert.ok(has(check('lore/X.md', expanded), 'AT3'));
});

const RETITLED = '---\ntype: subject\nprovenance:\n  generator: claude-opus-5\n---\n'
  + '# Stoicism\n\n> [!librarian] An agent has contributed to this file.\n\nStoicism is a philosophy.\n';

test('the retitled opening callout satisfies AT3, marker in any case', () => {
  for (const marker of ['> [!librarian] An agent has contributed to this file.',
    '> [!librarian]- An agent has contributed to this file.',
    '> [!Librarian] An agent has contributed to this file.',
    '> [!LIBRARIAN]- An agent has contributed to this file.']) {
    const doc = RETITLED.replace('> [!librarian] An agent has contributed to this file.', marker);
    assert.ok(!has(check('lore/Stoicism.md', doc), 'AT3'), marker);
  }
});

test('an uncollapsed callout with another title still fails AT3', () => {
  for (const title of ['An agent contributed to this file.', 'an agent has contributed to this file.',
    'An agent has contributed to this file', 'Agent-written page']) {
    const doc = RETITLED.replace('An agent has contributed to this file.', title);
    assert.deepEqual(only(check('lore/Stoicism.md', doc), 'AT3'), ['lore/Stoicism.md: AT3 body must open with a '
      + "'> [!librarian] An agent has contributed to this file.' callout, or the older collapsed '> [!librarian]-' one"], title);
  }
});

test('the attribution rules skip author zones (AT1, AT3)', () => {
  const doc = "---\ntype: writing\nprovenance:\n  origin: o\n  method: verbatim\n---\nThe author's prose, unmarked.\n";
  assert.deepEqual(check('writing/poetry/x.md', doc), []);
});

test('an unknown provenance subkey is PR3', () => {
  const doc = '---\ntype: source\nprovenance:\n  origin: o\n  method: verbatim\n  redaction: token removed\n---\nBody.\n';
  assert.ok(has(check('sources/a.md', doc), 'PR3', 'redaction'));
  const good = '---\ntype: source\nprovenance:\n  origin: o\n  method: verbatim\n'
    + '  converter: avalon-v1.5\n  legacy_frontmatter: |\n    x\n---\nBody.\n';
  assert.ok(!has(check('sources/a.md', good), 'PR3'));
});

// --- BD2: `--`, never an em dash, in librarian prose ---------------------------

const DASH = '—';
const head = '---\ntype: lore\nprovenance:\n  generator: claude-fable-5\n---\n# X\n\n> [!librarian]- Agent-written page\n> r\n\n';

test('an em dash is BD2 in librarian prose', () => {
  const doc = `${head}A clan of engineers ${DASH} the other half of the pairing.\n`;
  assert.ok(has(check('lore/X.md', doc), 'BD2'));
  assert.ok(!has(check('lore/X.md', doc.replace(DASH, '--')), 'BD2'));
});

// Quoted material is byte-protected: an em dash the author wrote is never "fixed".
test('an em dash inside quoted material is allowed (BD2)', () => {
  const doc = `${head}> Quoted receipt ${DASH} verbatim from the source.\n\n`
    + `The manuscript reads "a gilt sunburst ${DASH} held overhead" in that scene.\n`
    + `Inline code \`a ${DASH} b\` and a fence:\n\n\`\`\`\nplain ${DASH} text\n\`\`\`\n`;
  assert.ok(!has(check('lore/X.md', doc), 'BD2'));
});

test('quote state carries across lines (BD2)', () => {
  const doc = `${head}He says "the lamps that light the streets,\nthe ships ${DASH} all of it" here.\n`;
  assert.ok(!has(check('lore/X.md', doc), 'BD2'));
});

test('BD2 skips author zones', () => {
  const doc = `---\ntype: writing\nprovenance:\n  origin: o\n  method: verbatim\n---\nThe author's own prose ${DASH} em dashes and all.\n`;
  assert.ok(!has(check('writing/poetry/x.md', doc), 'BD2'));
});

test('an em dash inside a tilde fence is exempt (BD2)', () => {
  assert.ok(!has(check('lore/X.md', page(`~~~\nplain ${DASH} text\n~~~\n`)), 'BD2'));
});

// --- CS1: every citation names a speaker drawn from the right place ----------

const SOURCE_WITH_AUTHOR = '---\ntype: source\nprovenance:\n  origin: o\n  method: converted\n'
  + '  author: the Long Read\n---\nTranscript.\n';
const SOURCE_NO_AUTHOR = '---\ntype: source\nprovenance:\n  origin: o\n  method: converted\n---\nTranscript.\n';
const AUTHOR_NOTE = '---\ntype: writing\nproject: path\nprovenance:\n  origin: o\n'
  + "  method: verbatim\n---\nThe author's own prose.\n";

function page(body: string): string {
  return `---\ntype: subject\nprovenance:\n  generator: claude-opus-5\n---\n# X\n\n> [!librarian]- Agent-written page\n> r\n\n${body}`;
}

const cs1 = (doc: string, idx?: PageIndex) => only(check('lore/X.md', doc, idx), 'CS1');
const lanterns = () => index({ 'sources/lanterns.md': SOURCE_WITH_AUTHOR });

test("a citation's speaker must match the source's author (CS1)", () => {
  const idx = lanterns();
  assert.ok(has(cs1(page('It navigates ([[lanterns]] -- the hosts, on tide space).\n'), idx), 'the hosts', 'the Long Read'));
  assert.deepEqual(cs1(page('It navigates ([[lanterns]] -- the Long Read, on tide space).\n'), idx), []);
});

test('the speaker is the scheme\'s author for writing and the librarian for lore (CS1)', () => {
  const idx = index({ 'writing/path/x.md': AUTHOR_NOTE, 'lore/Tidecraft.md': page('p\n') });
  assert.deepEqual(cs1(page('A claim ([[x]] -- Mara, notes) and ([[Tidecraft]] -- librarian, Gaps).\n'), idx), []);
  assert.ok(has(cs1(page('A claim ([[x]] -- librarian, notes).\n'), idx), 'Mara'));
});

// The unattributed speaker is applied once, at discovery, and recorded; a citation may
// only repeat what is recorded, so naming it against a page that names a voice is a defect.
test('Unattributed passes only where the source records it (CS1)', () => {
  const doc = page('A claim ([[lanterns]] -- Unattributed, first critique).\n');
  const findings = cs1(doc, lanterns());
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('the Long Read'));
  const recorded = SOURCE_WITH_AUTHOR.replace('author: the Long Read', 'author: Unattributed');
  assert.deepEqual(cs1(doc, index({ 'sources/lanterns.md': recorded })), []);
});

test('Unattributed is rejected where a zone default names a voice (CS1)', () => {
  const idx = index({ 'writing/path/x.md': AUTHOR_NOTE, 'lore/Tidecraft.md': page('p\n') });
  for (const [target, expected] of [['x', 'Mara'], ['Tidecraft', 'librarian']]) {
    const findings = cs1(page(`A claim ([[${target}]] -- Unattributed, one).\n`), idx);
    assert.equal(findings.length, 1, target);
    assert.ok(findings[0]!.includes(expected!), target);
  }
});

test('a dangling wikilink is not a CS1 finding', () => {
  assert.deepEqual(cs1(page('A claim ([[no-such-page]] -- whoever, somewhere).\n'), index({})), []);
});

test('a source without an author is reported once, against the source (CS1)', () => {
  const idx = index({ 'sources/lanterns.md': SOURCE_NO_AUTHOR });
  const findings = cs1(page('A ([[lanterns]] -- the Long Read, one) and B ([[lanterns]] -- x, two).\n'), idx);
  assert.deepEqual(findings, ['sources/lanterns.md: CS1 provenance.author required (cited as a speaker by lore/X.md)']);
});

test('citations resolve by basename, alias, path and heading (CS1)', () => {
  const source = SOURCE_WITH_AUTHOR.replace('type: source\n', 'type: source\naliases:\n- Tail-Lit Lanterns\n');
  const idx = index({ 'sources/tide/lanterns.md': source });
  for (const link of ['[[lanterns]]', '[[Tail-Lit Lanterns]]', '[[sources/tide/lanterns]]', '[[lanterns#Section|the talk]]']) {
    assert.ok(cs1(page(`A claim (${link} -- the wrong voice, one).\n`), idx).length > 0, link);
  }
});

// False positives are the risk: only a link right against the marker counts.
test('ordinary parenthetical prose is not a citation (CS1)', () => {
  const doc = page('The pair (see [[lanterns]], and [[lanterns]] too) -- both of them --\n'
    + 'are recorded on [[lanterns]] (a transcript of two hosts).\n');
  assert.deepEqual(cs1(doc, lanterns()), []);
});

test('block and footer citation forms (CS1)', () => {
  const idx = lanterns();
  const block = page('> Quoted receipt.\n>\n> -- [[lanterns]] (the hosts, on tide space)\n');
  assert.ok(has(cs1(block, idx), 'the hosts'));
  assert.ok(has(cs1(page('## Attested in\n\n- [[lanterns]] (the hosts) -- the definition\n'), idx), 'the hosts'));
  assert.deepEqual(cs1(block.replace('(the hosts,', '(the Long Read,'), idx), []);
});

// The locator is optional; the speaker is not.
test('a block citation without a speaker (CS1)', () => {
  assert.ok(has(cs1(page('> Quoted receipt.\n>\n> -- [[lanterns]]\n'), lanterns()), 'no speaker'));
});

test('quoted and fenced material is exempt (CS1)', () => {
  const doc = page('> He wrote ([[lanterns]] -- the hosts, one) in the margin.\n\n'
    + '```\n([[lanterns]] -- the hosts, one)\n```\n\nInline `([[lanterns]] -- the hosts, one)` too.\n');
  assert.deepEqual(cs1(doc, lanterns()), []);
  assert.deepEqual(cs1(page('~~~\n([[lanterns]] -- the hosts, one)\n~~~\n'), lanterns()), []);
});

test('a wrapped citation is reported once, at its opening line (CS1)', () => {
  const findings = cs1(page('The pattern is primary ([[lanterns]] --\nthe hosts, on tide space).\n'), lanterns());
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.startsWith('lore/X.md:11:'));
});

test('CS1 skips author zones and needs an index', () => {
  const doc = '---\ntype: writing\nprovenance:\n  origin: o\n  method: verbatim\n---\nA claim ([[lanterns]] -- whoever, somewhere).\n';
  assert.deepEqual(check('writing/path/x.md', doc, lanterns()), []);
  assert.deepEqual(cs1(page('A claim ([[lanterns]] -- whoever, one).\n')), []);
});

test('the vault pass resolves citations across the vault (CS1)', () => {
  const findings = only(vault({ 'sources/lanterns.md': SOURCE_WITH_AUTHOR, 'lore/X.md': page('A claim ([[lanterns]] -- the hosts, one).\n') }), 'CS1');
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('the Long Read'));
});

// `--` is the ordinary prose dash, so a wholly mid-line `-- [[page]] (note)` is prose.
test('a block citation must be set off at a line start (CS1)', () => {
  assert.deepEqual(cs1(page('Writing -- [[lanterns]] (`topics` carry it), and more.\n'), lanterns()), []);
  assert.ok(cs1(page('-- [[lanterns]] (the hosts, on tide space)\n'), lanterns()).length > 0);
});

test('a block citation may wrap between the marker and the link (CS1)', () => {
  const findings = cs1(page('Research strand --\n[[lanterns]] (the hosts, on tide space).\n'), lanterns());
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('the hosts'));
});

// Code spans are masked to find citations, never to report them.
test('the speaker is quoted as written, even inside code spans (CS1)', () => {
  const findings = cs1(page('- [[lanterns]] (`sources/`) -- the video source already in the vault\n'), lanterns());
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes('`sources/`'));
});

test('expected speakers are not repeated (CS1)', () => {
  const idx = index({ 'sources/lanterns.md': SOURCE_WITH_AUTHOR.replace('author: the Long Read', 'author: Unattributed') });
  const findings = cs1(page('A claim ([[lanterns]] -- the hosts, one).\n'), idx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.split('Unattributed').length - 1, 1);
});

// Only sources/, writing/, lore/ and projects/ have an expected speaker.
test('citations outside the four zones are skipped (CS1)', () => {
  const idx = index({ 'Daily/2026-08-17.md': 'Habit:: done\n', 'inbox/scrap.md': 'a thought\n' });
  assert.deepEqual(cs1(page('A ([[2026-08-17]] -- whoever, one) and B ([[scrap]] -- whoever, two).\n'), idx), []);
});

// Every line-numbered rule counts FILE lines, frontmatter included, so a finding can be
// clicked; one fixture pins BD1, BD2, BD3 and CS1 to one convention.
test('line numbers are file-relative for BD1, BD2, BD3 and CS1', () => {
  const doc = '---\ntype: subject\nrole:\n- writer\nprovenance:\n  generator: claude-opus-5\n---\n'
    + '# X\n\n> [!librarian]- Agent-written page\n> r\n\nField:: legacy\n'
    + `A claim ([[lanterns]] -- the hosts, one) and an em dash ${DASH} here.\n`;
  const lines: Record<string, string> = {};
  for (const f of check('lore/X.md', doc, lanterns())) {
    const code = f.split(' ')[1]!.replace(/:$/, '');
    if (['BD1', 'BD2', 'BD3', 'CS1'].includes(code)) lines[code] = f.split(':')[1]!;
  }
  assert.deepEqual(lines, { BD1: '13', BD2: '14', BD3: '13', CS1: '14' });
});

test('a speaker wrapped across a line break (CS1)', () => {
  const idx = index({ 'sources/signal-engine.md': SOURCE_WITH_AUTHOR });
  const findings = cs1(page('the dimensions of this pattern space", which would shift the argument\n'
    + '([[signal-engine]] -- critique\nhosts, first critique). On that reading\n'), idx);
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes("'critique hosts'"));
});

// `provenance.author` is the list of voices a file carries, consulted in every zone.
test('an author list accepts each voice it names (CS1)', () => {
  for (const author of ['author: Zoë Marsh, Tomas Brand', 'author:\n  - Zoë Marsh\n  - Tomas Brand']) {
    const idx = index({ 'sources/talk.md': SOURCE_WITH_AUTHOR.replace('author: the Long Read', author) });
    for (const voice of ['Zoë Marsh', 'Tomas Brand']) {
      assert.deepEqual(cs1(page(`A claim ([[talk]] -- ${voice}, one).\n`), idx), [], voice);
    }
  }
});

test('an author list overrides the writing zone default (CS1)', () => {
  const note = AUTHOR_NOTE.replace('  method: verbatim\n', '  method: verbatim\n  author: Mara, Brand\n');
  const idx = index({ 'writing/odr-anvil/material/brand-notes.md': note });
  for (const voice of ['Mara', 'Brand']) assert.deepEqual(cs1(page(`A claim ([[brand-notes]] -- ${voice}, one).\n`), idx), []);
  const findings = cs1(page('A claim ([[brand-notes]] -- Okafor, one).\n'), idx);
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes("'Mara' or 'Brand'"));
});

test('a writing page without an author defaults to the scheme\'s author (CS1)', () => {
  const idx = index({ 'writing/path/x.md': AUTHOR_NOTE });
  assert.deepEqual(cs1(page('A ([[x]] -- Mara, one).\n'), idx), []);
  assert.ok(has(cs1(page('A ([[x]] -- someone else, one).\n'), idx), "'Mara'"));
});

test('a lore page without an author defaults to the librarian (CS1)', () => {
  const idx = index({ 'lore/Tidecraft.md': page('prose\n') });
  assert.deepEqual(cs1(page('A ([[Tidecraft]] -- librarian, Gaps).\n'), idx), []);
  assert.ok(has(cs1(page('A ([[Tidecraft]] -- Okafor, Gaps).\n'), idx), "'librarian'"));
});

test('author entries are trimmed (CS1)', () => {
  const idx = index({ 'sources/talk.md': SOURCE_WITH_AUTHOR.replace('author: the Long Read', "author: '  Mara ,   Brand  '") });
  for (const voice of ['Mara', 'Brand']) assert.deepEqual(cs1(page(`A claim ([[talk]] -- ${voice}, one).\n`), idx), []);
});

// A list is a set of alternatives, so naming all of them at once names no single voice.
test('the joined author string is not itself a speaker (CS1)', () => {
  const idx = index({ 'sources/debate.md': SOURCE_WITH_AUTHOR.replace('author: the Long Read', 'author: structure side, emergence side') });
  assert.equal(cs1(page('- [[debate]] (structure side and emergence side) -- one side\n'), idx).length, 1);
  assert.deepEqual(cs1(page('- [[debate]] (emergence side) -- one side\n'), idx), []);
});

test('the finding names every acceptable voice (CS1)', () => {
  const idx = index({ 'sources/talk.md': SOURCE_WITH_AUTHOR.replace('author: the Long Read', 'author: Zoë Marsh, Tomas Brand') });
  const findings = cs1(page('A claim ([[talk]] -- the hosts, one).\n'), idx);
  assert.equal(findings[0], "lore/X.md:11: CS1 citation of [[talk]] names speaker 'the hosts' (expected 'Zoë Marsh' or 'Tomas Brand')");
});

test('an inline citation inside a table keeps its target (CS1)', () => {
  const idx = index({ 'writing/path/the-boathouse.md': AUTHOR_NOTE });
  const findings = cs1(page('| "quoted" ([[the-boathouse\\|Path - The Boathouse]] -- Brand, opening) |\n'), idx);
  assert.deepEqual(findings, ["lore/X.md:11: CS1 citation of [[the-boathouse]] names speaker 'Brand' (expected 'Mara')"]);
});

// --- DP1: ghosts in _deprecated/ are never link targets ------------------------

test('a librarian-zone link into _deprecated/ is DP1', () => {
  const findings = vault({
    '_deprecated/2025-11-16-project-odr.md': '---\ntype: source\n---\nGhost body.\n',
    'lore/X.md': '---\ntype: subject\nprovenance:\n  generator: g\n---\n# X\n\n> [!librarian]- Agent-written page\n> r\n\n'
      + 'See [[2025-11-16-project-odr]] for history.\n',
  });
  assert.ok(findings.includes('lore/X.md: DP1 link into _deprecated/ -- [[2025-11-16-project-odr]] resolves to the ghost '
    + '_deprecated/2025-11-16-project-odr.md'));
});

test('DP1 counts topics links too', () => {
  assert.ok(has(vault({
    '_deprecated/2025-old-thing.md': '---\ntype: source\n---\nGhost body.\n',
    'lore/X.md': '---\ntype: subject\ntopics:\n- "[[2025-old-thing]]"\nprovenance:\n  generator: g\n---\n'
      + '# X\n\n> [!librarian]- Agent-written page\n> r\n\nBody.\n',
  }), 'DP1'));
});

test('DP1 is silent when the link resolves to a living page', () => {
  const living = (name: string, body: string) => `---\ntype: subject\nprovenance:\n  generator: g\n---\n# ${name}\n\n> [!librarian]- Agent-written page\n> r\n\n${body}`;
  assert.ok(!has(vault({ 'lore/X.md': living('X', 'See [[Y]].\n'), 'lore/Y.md': living('Y', 'Body.\n') }), 'DP1'));
});

test('DP1 ignores links inside the ghosts themselves', () => {
  assert.ok(!has(vault({
    '_deprecated/2025-a.md': '---\ntype: source\n---\nSee [[2025-b]].\n',
    '_deprecated/2025-b.md': '---\ntype: source\n---\nGhost body.\n',
  }), 'DP1'));
});

// --- human spans on librarian pages are author bytes ---------------------------

const CHIMERA = '---\ntype: lore\nsetting: odr\nprovenance:\n  generator: g\n  author: librarian, Mara\n---\n'
  + '# X\n\n> [!librarian]- Agent-written page\n> r\n\nLibrarian gloss.\n\n> [!human] Character sheet\n\n'
  + `Related:: \nShe wasn't purely authentic${DASH}she was aware of its utility.\n\n> [!librarian] Filing\n\nFooter prose.\n`;

test('BD1 and BD2 exempt human spans', () => {
  assert.deepEqual(check('lore/X.md', CHIMERA), []);
});

test('BD1 and BD2 still fire outside the human span', () => {
  const findings = check('lore/X.md', `${CHIMERA}\nKey:: value\nAnd an em${DASH}dash.\n`);
  assert.ok(has(findings, 'BD1'));
  assert.ok(has(findings, 'BD2'));
});

// Ownership the caller proves (hoard pinned it in git) replaces the markers.
test('protected lines from the caller replace the markers', () => {
  const doc = page('Key:: value\n');
  assert.ok(has(check('lore/X.md', doc), 'BD1'));
  assert.ok(!has(check('lore/X.md', doc, undefined, { protectedLines: new Set([11]) }), 'BD1'));
});

test('marker recognition is case-insensitive', () => {
  assert.deepEqual(humanSpanLines('a\n> [!Human]- x\nb\nc\n> [!LIBRARIAN]\nd\n'), new Set([3, 4]));
  const doc = '---\ntype: lore\nprovenance:\n  generator: claude-fable-5\n---\n# X\n\n> [!Librarian]- Agent-written page\n\nProse.\n';
  assert.ok(!has(check('lore/X.md', doc), 'AT3'));
});

// --- BD3: one paragraph = one line ---------------------------------------------

const BD3 = 'BD3 wrapped paragraph (one paragraph = one line)';
const bd3 = (doc: string, relpath = 'lore/X.md') => only(check(relpath, doc), 'BD3');

test('a wrapped paragraph is one finding at its opening line (BD3)', () => {
  assert.deepEqual(bd3(page('Obsidian renders every newline as a line break, so a\nhard-wrapped paragraph flows badly on the page.\n')),
    [`lore/X.md:11: ${BD3}`]);
});

test('one-line paragraphs are clean (BD3)', () => {
  assert.deepEqual(bd3(page('One paragraph on one line.\n\nAnd a second, also on one.\n')), []);
});

test('each wrapped paragraph is reported once (BD3)', () => {
  const findings = bd3(page('First wrapped paragraph, line one\nline two\nline three\n\nSecond wrapped paragraph, line one\nline two\n'));
  assert.deepEqual(findings.map((f) => f.split(':')[1]), ['11', '15']);
});

test('structure is not prose (BD3)', () => {
  assert.deepEqual(bd3(page('## Heading\n| Zone | Purpose |\n|---|---|\n| lore | topic nodes |\n> Quoted receipt, wrapped\n'
    + '> as the author wrote it.\n- a bullet\n- another bullet\n1. a numbered item\n2. another numbered item\n'
    + '```\ncode line one\ncode line two\n```\n')), []);
  assert.deepEqual(bd3(page('~~~\ncode line one\ncode line two\n~~~\n')), []);
});

test('indented list continuations form a run (BD3)', () => {
  assert.deepEqual(bd3(page('- a bullet whose continuation\n  is indented beneath it\n  and runs on again\n')), [`lore/X.md:11: ${BD3}`]);
});

test('a blank-separated indented paragraph is clean (BD3)', () => {
  assert.deepEqual(bd3(page('- a bullet\n\n  its continuation, on one line\n\n- another\n')), []);
});

test('indented structure under a bullet is not prose (BD3)', () => {
  assert.deepEqual(bd3(page('- a bullet\n  > quoted receipt, wrapped\n  > as the author wrote it.\n')), []);
  assert.deepEqual(bd3(page('- a bullet\n  | Zone | Purpose |\n  |---|---|\n')), []);
});

test('lazy bullet continuations land on the bullet (BD3)', () => {
  assert.deepEqual(bd3(page('- a bullet\nlazy one\nlazy two\n')), [`lore/X.md:11: ${BD3}`]);
});

// A quote line and its sign-off are the shape CS1 reads, never a wrap.
test('a block citation closes a run (BD3)', () => {
  assert.deepEqual(bd3(page('The vault calls it "a wedge".\n-- [[lanterns]] (Mara, one)\n')), []);
  assert.deepEqual(bd3(page('- a bullet quoting it\n  -- [[lanterns]] (Mara, one)\n')), []);
});

test('a two-space hard break closes a paragraph (BD3)', () => {
  assert.deepEqual(bd3(page('A deliberate break here.  \nAnd the line after it.\n')), []);
  const findings = bd3(page('Wrapped onto\na second line.  \nA line after the break.\n'));
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.startsWith('lore/X.md:11:'));
});

test('human spans are exempt (BD3)', () => {
  assert.deepEqual(bd3(page("> [!human] Character sheet\n\nShe wasn't purely authentic,\nshe was aware of its utility.\n\n"
    + '> [!librarian] Filing\n\nFooter prose.\n')), []);
});

// Author bytes are read for exemption, never for structure.
test('a fence inside a human span cannot silence BD3', () => {
  assert.equal(bd3(page('> [!human] Character sheet\n\n```\n\n> [!librarian] Filing\n\nLibrarian prose wrapped\nover two lines.\n')).length, 1);
});

// A generator's spec in an HTML comment must stay one key per line.
test('a table spec comment is structure (BD3)', () => {
  assert.deepEqual(bd3(page('<!-- hoard-table\nwhere:\n  setting: self\ncolumns: [page, type]\nsort: page\n-->\n'
    + '| Page | Type |\n| --- | --- |\n| [[a]] | lore |\n<!-- /hoard-table 3f2a1b7c -->\n')), []);
});

test('prose after a comment block is still judged (BD3)', () => {
  assert.equal(bd3(page('<!-- hoard-table\nwhere:\n  setting: self\n-->\n\nLibrarian prose wrapped\nover two lines.\n')).length, 1);
});

test('BD3 skips author zones', () => {
  assert.deepEqual(check('writing/poetry/x.md', "---\ntype: writing\nprovenance:\n  origin: o\n  method: verbatim\n---\n"
    + "The author's own prose, wrapped\nexactly as they wrapped it.\n"), []);
  assert.deepEqual(bd3('---\ntype: source\nprovenance:\n  origin: o\n  method: verbatim\n  author: Mara\n---\n'
    + 'A transcript, wrapped\nas it arrived.\n', 'sources/a.md'), []);
});

// The vault index is a root file, so infra, and BD3 carves it in by name and alone: it
// carries no frontmatter and must not grow an FM1.
test('INDEX.md is carved into BD3', () => {
  assert.equal(zoneOf('INDEX.md', HOARD_LAYOUT), 'infra');
  assert.deepEqual(check('INDEX.md', '# Library Index\n\nThe librarian maintains this map. Humans read it;\nthey never update it.\n'),
    [`INDEX.md:3: ${BD3}`]);
  assert.deepEqual(check('INDEX.md', '# Library Index\n\nThe librarian maintains this map.\n'), []);
});

test('other root files are not judged', () => {
  assert.deepEqual(check('README.md', 'Wrapped prose\nover two lines.\n'), []);
  assert.deepEqual(check('CLAUDE.md', 'Wrapped rulebook prose\nover two lines.\n'), []);
});

test('INDEX.md with unparseable frontmatter is FM11, and it fails', () => {
  const { result, records } = captureLogs(() => check('INDEX.md', '---\ntype: [oops\n---\n# Library Index\n'));
  assert.equal(result.length, 1);
  assert.ok(result[0]!.startsWith('INDEX.md: FM11 frontmatter would not parse, so BD3 could not run: '));
  assert.ok(fails(result));
  assert.ok(records.some((r) => r.logger === 'librarian.lint' && r.level === 'warning' && r.message.startsWith('BD3 cannot read INDEX.md')));
});

// --- Track Changes: pending marks are parsed, not tripped over -------------------
// Ownership follows a mark's form, never its author attribute.

test('BD2 fires inside an insertion and a comment, not a deletion', () => {
  assert.ok(has(check('lore/X.md', page(`A clause{++ and an em${DASH}dash proposal++}.\n`)), 'BD2'));
  assert.ok(has(check('lore/X.md', page(`A clause{>>this em${DASH}dash is the librarian's<<}.\n`)), 'BD2'));
  assert.ok(!has(check('lore/X.md', page(`A clause{-- with an em${DASH}dash the author wrote--}.\n`)), 'BD2'));
});

test("BD2 judges a substitution's new text, not its old text", () => {
  assert.ok(has(check('lore/X.md', page(`A clause {~~old${DASH}text~>new${DASH}text~~}.\n`)), 'BD2'));
  assert.ok(!has(check('lore/X.md', page(`A clause {~~old${DASH}text~>new text~~}.\n`)), 'BD2'));
});

test('BD3 ignores a mark that wraps inside a paragraph', () => {
  assert.deepEqual(bd3(page('One paragraph on one line{-- with a deletion\nthat wraps--} and a tail.\n')), []);
});

test('BD3 still fires on a wrapped paragraph carrying a mark', () => {
  assert.equal(bd3(page('A paragraph{++ with an insertion++} that is\ngenuinely hard wrapped.\n')).length, 1);
});

const SOURCE = '---\ntype: source\nprovenance:\n  origin: o\n  method: converted\n  author: the Long Read\n---\nSource body.\n';

test('CS1 ignores a citation inside a comment mark and judges one inside an insertion', () => {
  assert.ok(!has(vault({ 'sources/lanterns.md': SOURCE, 'lore/X.md': page('A claim{>>should this cite ([[lanterns]] -- Nobody)?<<}.\n') }), 'CS1'));
  assert.ok(has(vault({ 'sources/lanterns.md': SOURCE, 'lore/X.md': page('A claim{++ ([[lanterns]] -- Nobody)++}.\n') }), 'CS1'));
});

// The rules read a length-preserving mask, not resolved text.
test('a mark does not shift the line a finding reports', () => {
  const run = (body: string) => only(vault({ 'sources/lanterns.md': SOURCE, 'lore/X.md': page(body) }), 'CS1');
  const marked = run('Opening{-- deleted across\ntwo lines--}.\n\nA claim ([[lanterns]] -- Nobody).\n');
  assert.equal(marked.length, 1);
  assert.deepEqual(marked, run('Opening deleted across\ntwo lines.\n\nA claim ([[lanterns]] -- Nobody).\n'));
});

test('DP1 ignores a ghost link inside a deletion and flags one inside an insertion', () => {
  const ghost = '---\ntype: source\n---\nGhost body.\n';
  assert.ok(!has(vault({ '_deprecated/2025-old-thing.md': ghost, 'lore/X.md': page('Text{-- see [[2025-old-thing]]--} and on.\n') }), 'DP1'));
  assert.ok(has(vault({ '_deprecated/2025-old-thing.md': ghost, 'lore/X.md': page('Text{++ see [[2025-old-thing]]++} and on.\n') }), 'DP1'));
});

test('LK1 ignores an alias-only link inside a deletion and flags one inside an insertion', () => {
  const y = '---\ntype: subject\naliases: [oldname]\nprovenance:\n  generator: g\n---\n# Y\n\n> [!librarian]- Agent-written page\n> r\n';
  assert.ok(!has(vault({ 'lore/Y.md': y, 'lore/X.md': page('Text{-- see [[oldname]]--} on.\n') }), 'LK1'));
  assert.ok(has(vault({ 'lore/Y.md': y, 'lore/X.md': page('Text{++ see [[oldname]]++} on.\n') }), 'LK1'));
});

test('TC1 flags a malformed mark on a librarian page and in an author file', () => {
  assert.ok(check('lore/X.md', page('A line with {++ no close before the paragraph ends.\n'))
    .some((f) => f.startsWith('lore/X.md:11: TC1 malformed CriticMarkup mark')));
  const doc = '---\ntype: writing\nprovenance:\n  origin: o\n  method: verbatim\n---\nA line with {-- no close on it.\n';
  assert.ok(has(check('writing/path/x.md', doc), 'TC1'));
});

test('TC1 flags a broken attribute prefix', () => {
  assert.ok(has(check('lore/X.md', page('A line {author="Claude++x++} here.\n')), 'TC1'));
});

test('TC1 is silent on a well-formed mark and on ordinary braces', () => {
  assert.ok(!has(check('lore/X.md', page('A line {author="Claude" date="2026-06-14"++ added++} here.\n')), 'TC1'));
  assert.ok(!has(check('lore/X.md', page('The set {a, b} and the field {key=value} are prose.\n')), 'TC1'));
});

test('TC2 reports a nested mark, informationally', () => {
  const findings = only(check('lore/X.md', page('A clause{++ outer {--inner--} text++}.\n')), 'TC2');
  assert.deepEqual(findings, ["lore/X.md:11: TC2 nested CriticMarkup mark, INFORMATIONAL (the inner mark is read as the outer one's content)"]);
  assert.ok(!fails(findings));
});

test('informational findings never fail the check', () => {
  assert.ok(fails(['lore/X.md:11: TC2 nested CriticMarkup mark, INFORMATIONAL (x)', `lore/X.md:11: ${BD3}`]));
  assert.ok(!fails(['lore/X.md:11: TC2 nested CriticMarkup mark, INFORMATIONAL (x)']));
  assert.ok(!fails([]));
});

// --- LK2: basenames are unique vault-wide; an alias never shadows a page --------

const PAGE_FM = '---\ntype: subject\n---\n';
const lk2 = (files: Record<string, string>) => only(vault(files), 'LK2');

test('a basename collision is LK2, against the later page', () => {
  assert.deepEqual(lk2({ 'lore/Story-Calendar.md': PAGE_FM, 'projects/story-calendar.md': PAGE_FM }), [
    "projects/story-calendar.md: LK2 basename 'story-calendar' collides with lore/Story-Calendar.md "
    + '(case-insensitive; Obsidian resolves [[story-calendar]] to one of them)']);
});

test("an alias colliding with another page's basename is LK2", () => {
  assert.deepEqual(lk2({ 'lore/Tidecraft.md': '---\ntype: subject\naliases:\n- Agency\n---\n', 'lore/Agency.md': PAGE_FM }), [
    "lore/Tidecraft.md: LK2 alias 'Agency' collides with the basename of lore/Agency.md ([[Agency]] can never reach this page)"]);
});

test('an alias shared by two pages is LK2', () => {
  const a = '---\ntype: subject\naliases:\n- x\n---\n';
  assert.deepEqual(lk2({ 'lore/A.md': a, 'lore/B.md': a }), ["lore/B.md: LK2 alias 'x' is also an alias of lore/A.md"]);
});

test('an alias equal to its own basename is not LK2', () => {
  assert.deepEqual(lk2({ 'lore/Fernbridge.md': '---\ntype: lore\nsetting: odr\naliases:\n- fernbridge\n---\n' }), []);
});

// `_deprecated/` sorts before `lore/` in the walk, so a ghost wins the key; the finding
// lands on the living page, where a reader goes to fix it.
test('a ghost wins the key and is still reported (LK2)', () => {
  assert.deepEqual(lk2({ 'lore/x.md': PAGE_FM, '_deprecated/x.md': PAGE_FM }), [
    "lore/x.md: LK2 basename 'x' collides with _deprecated/x.md (case-insensitive; Obsidian resolves [[x]] to one of them)"]);
});

test('infra-only pairs are silent (LK2)', () => {
  assert.deepEqual(lk2({ '_meta/a/README.md': 'x\n', '_meta/b/README.md': 'y\n' }), []);
});

// --- LK1: a link only an alias answers is broken in Obsidian ---------------------

const KELLA = "---\ntype: lore\nsetting: odr\naliases:\n- kella\n---\n";
const lk1 = (files: Record<string, string>) => only(vault(files), 'LK1');

test('an alias-only body link is LK1', () => {
  assert.deepEqual(lk1({ "lore/Kell'a.md": KELLA, 'lore/X.md': page('See [[kella]].\n') }),
    ["lore/X.md:11: LK1 alias-only link [[kella]] -> Kell'a"]);
});

test('piped, anchored and embedded forms are still LK1', () => {
  const found = lk1({ "lore/Kell'a.md": KELLA, 'lore/X.md': page('[[kella|her]]\n\n[[kella#Sheet]]\n\n![[kella]]\n') });
  assert.deepEqual(found.map((f) => f.split(': ').slice(1).join(': ')), Array(3).fill("LK1 alias-only link [[kella]] -> Kell'a"));
  assert.deepEqual(found.map((f) => f.split(':')[1]), ['11', '13', '15']);
});

test('a topics entry reports the frontmatter line (LK1)', () => {
  const doc = '---\ntype: subject\ntopics:\n- "[[kella]]"\nprovenance:\n  generator: claude-opus-5\n---\n# X\n\n> [!librarian]- p\n> r\n';
  assert.deepEqual(lk1({ "lore/Kell'a.md": KELLA, 'lore/X.md': doc }), ["lore/X.md:4: LK1 alias-only link [[kella]] -> Kell'a"]);
});

test('basename, case and path forms are clean (LK1)', () => {
  assert.deepEqual(lk1({ "lore/Kell'a.md": KELLA, 'lore/X.md': page("[[KELL'A]] [[lore/Kell'a]] [[Kell'a.md]] [[Kell'a|she]]\n") }), []);
});

// A link-target rewrite is permitted in author bytes, so they are reported, tagged;
// frontmatter `topics` is librarian metadata in every zone and carries no tag.
test('author bytes are tagged, not exempt (LK1)', () => {
  const found = lk1({
    "lore/Kell'a.md": KELLA,
    'writing/a.md': AUTHOR_NOTE.replace("The author's own prose.", 'Their [[kella]].'),
    'lore/H.md': page('> [!human]- sheet\n\nHer [[kella]].\n\n> [!librarian]- f\n\nOurs [[kella]].\n'),
    'writing/t.md': '---\ntype: writing\ntopics:\n- "[[kella]]"\nprovenance:\n  origin: o\n---\nProse.\n',
  });
  assert.deepEqual(found.sort(), [
    "lore/H.md:13: LK1 alias-only link [[kella]] -> Kell'a (author bytes)",
    "lore/H.md:17: LK1 alias-only link [[kella]] -> Kell'a",
    "writing/a.md:8: LK1 alias-only link [[kella]] -> Kell'a (author bytes)",
    "writing/t.md:4: LK1 alias-only link [[kella]] -> Kell'a",
  ]);
});

test('the index counts for LK1; the inbox, infra and code do not', () => {
  assert.deepEqual(lk1({
    "lore/Kell'a.md": KELLA, 'INDEX.md': '# Index\n\n- [[kella]]\n', 'inbox/scratch.md': '[[kella]]\n',
    '_meta/notes.md': '[[kella]]\n', 'lore/X.md': page('`[[kella]]`\n\n```\n[[kella]]\n```\n'),
  }), ["INDEX.md:3: LK1 alias-only link [[kella]] -> Kell'a"]);
});

test('an NFD link hits an NFC alias (LK1)', () => {
  const nfd = 'Ilōraḥ'.normalize('NFD');
  const found = lk1({ 'writing/iloraj.md': AUTHOR_NOTE.replace('---\n', '---\naliases:\n- Ilōraḥ\n'), 'lore/X.md': page(`See [[${nfd}]].\n`) });
  assert.equal(found.length, 1);
  assert.ok(found[0]!.includes('-> iloraj'));
});

// [[Agency]] lands on lore/Agency.md in Obsidian; the confusion is LK2's.
test('an alias that loses to a basename is not LK1', () => {
  assert.deepEqual(lk1({ 'lore/Tidecraft.md': '---\ntype: subject\naliases:\n- Agency\n---\n', 'lore/Agency.md': PAGE_FM,
    'lore/X.md': page('[[Agency]]\n') }), []);
});

// --- CS2: the unattributed rung requires an operation log line --------------------

const UNATTRIBUTED_PAGE = '---\ntype: source\nprovenance:\n  origin: o\n  method: verbatim\n  author: Unattributed\n---\nWelcome back.\n';
const cs2 = (files: Record<string, string>, logText: string) => only(vault(files, logText), 'CS2');

test('Unattributed without a log line is CS2', () => {
  assert.deepEqual(cs2({ 'sources/signal-engine.md': UNATTRIBUTED_PAGE }, '- 2026-09-06T00:00:00Z · infra · unrelated line\n'),
    ['sources/signal-engine.md: CS2 provenance.author Unattributed with no _meta/LOG.md line recording the ladder check']);
});

test('Unattributed with a log line passes CS2', () => {
  assert.deepEqual(cs2({ 'sources/signal-engine.md': UNATTRIBUTED_PAGE }, '- 2026-08-18T00:00:00Z · ingest · '
    + 'the-quiet-signal-engine: no speaker found, rungs 1-2 checked, recorded Unattributed\n'), []);
});

test("CS2's log match is case-blind on the basename", () => {
  assert.deepEqual(cs2({ 'sources/Tide-Space.md': UNATTRIBUTED_PAGE }, '- 2026-08-17T00:00:00Z · ingest · tide-space speaker discovery\n'), []);
  assert.deepEqual(cs2({ 'sources/Straße.md': UNATTRIBUTED_PAGE }, 'checked strasse by hand\n'), []);
});

test('CS2 matches any listed author entry', () => {
  const doc = '---\ntype: source\nprovenance:\n  origin: o\n  method: verbatim\n  author: Mara, Unattributed\n---\nbody\n';
  const found = cs2({ 'sources/tide-space-notes.md': doc }, 'nothing relevant\n');
  assert.equal(found.length, 1);
  assert.ok(found[0]!.includes('sources/tide-space-notes.md'));
});

test('CS2 needs nothing when Unattributed is absent', () => {
  const doc = '---\ntype: source\nprovenance:\n  origin: o\n  method: verbatim\n  author: Mara\n---\nbody\n';
  assert.deepEqual(cs2({ 'sources/a.md': doc }, 'nothing relevant\n'), []);
});

test('CS2 survives an empty or missing log', () => {
  assert.equal(cs2({ 'sources/a.md': UNATTRIBUTED_PAGE }, '').length, 1);
});

// --- no-swallow: every recovery is logged ----------------------------------------

const MALFORMED = '---\n: : :\n---\nbody\n';
const warned = (records: { logger: string; level: string; message: string }[], text: string) =>
  records.some((r) => r.logger === 'librarian.lint' && r.level === 'warning' && r.message.includes(text));

test('the alias-link check logs its raw-text fallback', () => {
  const { records } = captureLogs(() => checkAliasLinks('lore/x.md', '---\n: : :\n---\n[[a]]\n', new PageIndex()));
  assert.ok(warned(records, 'alias-only link check used raw text'));
});

test('the speaker ladder logs a skipped page', () => {
  const { records } = captureLogs(() => checkSpeakerLadder([['lore/x.md', MALFORMED]], ''));
  assert.ok(warned(records, 'speaker ladder skipped'));
});

test('FM2 is a finding and the parse failure is logged', () => {
  const { result, records } = captureLogs(() => check('lore/x.md', MALFORMED));
  assert.ok(has(result, 'FM2'));
  assert.ok(warned(records, 'failed to parse'));
});

test('asAccepted logs its raw-text fallback, naming the file', () => {
  const text = '---\n: : :\n---\nText{++ added++}.\n';
  const { result, records } = captureLogs(() => asAccepted('lore/x.md', text));
  assert.equal(result, text);
  assert.ok(warned(records, 'lore/x.md'));
});

test('the vault pass logs what it indexed and found', () => {
  const { records } = captureLogs(() => vault({ 'lore/bad.md': 'no fm\n' }));
  assert.deepEqual(records.filter((r) => r.level === 'info').map((r) => r.message),
    ['lint: indexed 1 notes for link resolution', 'lint: 1 note findings']);
});

test('LK2 findings are sorted', () => {
  const found = lk2({ 'lore/A.md': '---\ntype: subject\naliases:\n- zz\n---\n', 'lore/m.md': PAGE_FM,
    'projects/m.md': PAGE_FM, 'projects/zz.md': PAGE_FM });
  assert.deepEqual(found.map((f) => f.split(':')[0]), ['lore/A.md', 'projects/m.md']);
});
