// Rules for Ripple This Page (ripple/window.ts):
// - it asks about the page open in the page column, by its id, and about nothing else;
// - with no page open it says so and asks nothing;
// - a page ripple already has the words of is said to be known, with its packet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rippleThisPage } from '../../src/hoard/ripple/window.ts';

function fakeNeo(asked: { made: boolean; packet: string | null } | Error) {
  const calls: { channel: string; payload: unknown }[] = [];
  return {
    calls,
    neo: {
      async invoke(channel: string, payload?: unknown) {
        calls.push({ channel, payload });
        if (asked instanceof Error) throw asked;
        return asked;
      },
    },
  };
}

test('with no page open it says so and asks nothing', async () => {
  const { neo, calls } = fakeNeo({ made: true, packet: '/p.md' });
  const said = await rippleThisPage(neo, () => null);
  assert.deepEqual(said, { text: 'No page is open in the page column. Open one from Pages in the left pane, then choose Ripple This Page.', bad: true });
  assert.deepEqual(calls, []);
});

test('it asks about the page open in the column, by id, whichever tree', async () => {
  for (const page of ['wiki/People/Name.html', 'sources/Notes/Field.html']) {
    const { neo, calls } = fakeNeo({ made: true, packet: '/lib/.neo/ripple/packets/j.md' });
    const said = await rippleThisPage(neo, () => page);
    assert.deepEqual(calls, [{ channel: 'ripple.ask', payload: { page } }]);
    assert.equal(said.bad, false);
    assert.match(said.text, /The packet for .* is in the packets folder, for the judge: \/lib\/\.neo\/ripple\/packets\/j\.md/);
  }
});

test('a page whose words ripple has already is said to be known, and a refusal is shown as one', async () => {
  const known = await rippleThisPage(fakeNeo({ made: false, packet: '/p.md' }).neo, () => 'wiki/A.html');
  assert.deepEqual(known, { text: 'Ripple has this page\'s words already; its packet is /p.md.', bad: false });
  const refused = await rippleThisPage(fakeNeo(new Error('The page is not in the library.')).neo, () => 'wiki/A.html');
  assert.deepEqual(refused, { text: 'The page is not in the library.', bad: true });
});
