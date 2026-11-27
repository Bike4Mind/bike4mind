/**
 * How many operational model calls one queued session operation costs at most.
 *
 * Its own module rather than an export of `sessionOperationalCreditPreflight` because three
 * route tests mock that module wholesale (`sessions/[id]/__tests__/operational-credit-wiring`,
 * `projects/[id]/__tests__/sessions.credit-preflight`,
 * `admin/__tests__/recalculate-message-counts.credit-preflight`). `importOriginal` would also
 * keep the real value and is the repo's more usual answer, but it would have to be got right in
 * each of those three factories, and one that omits the constant yields `undefined`, which
 * multiplies into a `NaN` requirement rather than failing outright. A separate module cannot be
 * mocked away by accident. `maxFileSizeDefault.ts` is the same shape for a similar reason.
 */

/**
 * Operational calls a Summarize published with `callTagging` queues: the summary itself, plus the
 * Tag it cascades to at `sessionSummarization.ts:344-345`.
 *
 * An UPPER BOUND, and one the handler frequently does not reach: it bails at
 * `sessionSummarization.ts:82-85` when a session has no quests newer than its last summary and
 * the operations model has not changed, returning before both the LLM call and the cascaded Tag.
 * A re-summarize of an idle notebook therefore costs 0, not 2, and the gate over-refuses a holder
 * sitting within 2 credits of the line. Deliberate: the alternative is reading every session's
 * quest history at queue time, and a pre-flight that cheap cannot also be exact.
 *
 * Pinned to the real cascade by `sessionSummarization.test.ts` on BOTH legs - the settlement call
 * for the summary and the Tag publish - so adding or removing a cascaded operational call fails
 * there until this number moves to match.
 */
export const OPERATIONS_PER_SUMMARIZE_WITH_TAGGING = 2;
