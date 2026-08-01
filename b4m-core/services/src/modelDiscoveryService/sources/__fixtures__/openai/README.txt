pricing.md and the four model-*.md files are LIVE CAPTURES, fetched 2026-07-31
from platform.openai.com (which serves a markdown twin of any docs page at
<path>.md). No row, rate or bullet is edited.

pricing.md is trimmed to the Standard table the parser reads plus four tables it
must NOT read: Batch and Flex, whose headers are byte-identical to Standard's and
whose rates are half of it; Fast, which carries only the four short-context
columns; and a Grouped Pricing table, whose columns are a different shape
entirely. Picking any of them fails a test.

The model-*.md captures cover the shapes of the long-context breakpoint bullet:
gpt-5.6-luna and gpt-5.6-sol state it plainly, gpt-5.4 buries it in a longer
sentence about the family, and gpt-5.4-mini has no long-context pricing and so no
bullet at all. sol also serves as the wrong page in the test that proves a
breakpoint is refused unless the page states the model id it was asked for. One
prose paragraph carrying a curly apostrophe was dropped from each (the repo is
ASCII-only); it is boilerplate no parser reads.

parser-broke-pricing.md is CONSTRUCTED: the page restructured so the Standard
heading and the "Short context" column names are gone. It must parse to a
failure, never to a partial table.

models.json, expected.json and the malformed/empty/unknown-enum variants are the
/v1/models fixtures and predate this set.
