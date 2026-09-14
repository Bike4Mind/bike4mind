/**
 * How many operational model calls one queued session operation actually costs.
 *
 * Deliberately its own module rather than an export of `sessionOperationalCreditPreflight`: the
 * route tests mock that module wholesale, and a constant re-declared inside a `vi.mock` factory
 * stops tracking the real value the moment the two disagree. Importing it from here means those
 * tests read the number the routes read.
 */

/**
 * Operational calls a Summarize published with `callTagging` queues: the summary itself, plus the
 * Tag it cascades to at `sessionSummarization.ts:344-345`. Pinned to that cascade by
 * `sessionSummarization.test.ts` so adding or removing a cascaded call fails rather than silently
 * mispricing every publisher that sets the flag.
 */
export const OPERATIONS_PER_SUMMARIZE_WITH_TAGGING = 2;
