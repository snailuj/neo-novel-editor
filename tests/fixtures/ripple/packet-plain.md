# Ripple packet job-t0001

One change came into the library: the page below. Decide what it means for the wiki's other pages: which need a change, which should name it, and whether a page is missing.

- Source: [[Tide Ledger]], hop 0, commit bbbbbbbbbbbb
- Brief: /lib/.neo/ripple/brief.md. Read it before anything else; it is not in this packet.
- Answer file: /lib/.neo/ripple/inbox/job-t0001.jsonl
- Library: /lib (read-only for you)

## How to answer

Read the brief first, then the source, then any candidate you need in full (each card names its file). Write your answer as JSON, one object per line, to the answer file. Nothing else goes in it.

The first line is the preflight:

    {"kind": "preflight", "brief_sha256": "<the SHA-256 of the brief file's bytes, in hex>", "echo": "<at least 40 characters copied from the brief>"}

Then one line for each page you rule on:

    {"kind": "nothing", "target": "<page title>", "reason": "<why the page needs no change>"}
    {"kind": "claim", "target": "<page title>", "anchor": "<words on that page now, inside one paragraph>", "text": "<what those words become>", "reason": "<why>", "quote": "<the source's words this rests on>"}
    {"kind": "topic", "target": "<page title>", "line": "<a line to add to the page, usually naming the source as a [[link]]>", "reason": "<why>", "quote": "<the source's words>"}
    {"kind": "mint", "title": "<a new page's title>", "text": "<its first passage; a blank line parts paragraphs>", "reason": "<why>", "quote": "<the source's words>"}

- A target is a page title as a card gives it, or a page you found in the wiki.
- A quote is the source's own words, 12 characters or more. [Brackets] may hold your own words and ... may mark a gap.
- An anchor and its text stay inside one paragraph, with no line break.
- Say nothing of a page you leave alone. A "nothing" line is for a page you looked at and decided against, so the decision is kept.
- Nothing you write changes the library by itself: the author reads each proposal and applies it or not.

## Source: Tide Ledger

---
type: source
---
# Tide ledger

Wren Calder kept the ledger for the brine kilns through the wet season. The kelp tithe rose twice.
She noted that [[Harbour-Light]] went dark on the night of the second tithe.

The ledger mentions `Old-Mill` only in a filing code.

## Candidates (8)

The pages the source names or sits near in the links, then pages that share its words. (The meaning model is not set up, so its ten are missing.)

- [[Harbour Light]] (named): The harbour light stands on the breakwater and is lit at dusk.
  file: book-w/chapters/c2.html
  > The harbour light stands on the breakwater and is lit at dusk.
- [[Kelp Tithe]] (named): A levy paid in dried weed to the quay council each spring.
  file: book-w/chapters/c3.html (the author's page: a claim on it becomes a suggestion)
- [[Wren Calder]] (named): Wren Calder is the ledger keeper of the eastern quay.
  file: book-w/chapters/c5.html (the author's page: a claim on it becomes a suggestion)
  > Wren Calder is the ledger keeper of the eastern quay.
- [[Chapter One]] (hop 1): The first scene borrows from the Tide-Ledger.
  file: book-w/chapters/c8.html
  > The first scene borrows from the Tide-Ledger.
- [[Gull Rock]] (hop 2): Gull Rock lies a mile past Harbour-Light.
  file: book-w/chapters/c1.html (the author's page: a claim on it becomes a suggestion)
  > Gull Rock lies a mile past Harbour-Light.
- [[Brine Works]]: The brine works run six kilns. Brine kilns are fired with driftwood, and the kilns smoke through the wet season. Salt from the kilns is weighed at the quay.
  file: book-w/chapters/c0.html
  > The brine works run six kilns. Brine kilns are fired with driftwood, and the kilns smoke through the wet season.
- [[Old Mill]]: A ruined mill upriver, long out of use.
  file: book-w/chapters/c4.html
- [[Saltmere Era]]: The era hub for the coast stories.
  file: book-w/chapters/c6.html
