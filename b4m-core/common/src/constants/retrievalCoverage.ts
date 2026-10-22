/**
 * User-facing copy for the partial-grounding-coverage affordance.
 *
 * Single source of truth for the reader-facing half of the signal reported by two surfaces:
 *  - server: reportCoverage (services: ChatCompletionFeatures.ts), which writes the id-bearing
 *    diagnostic string to `promptMeta.warnings` and the reader-facing reasons to
 *    `promptMeta.retrievalCoverage`
 *  - chat: the `retrieval-coverage-warning` notice (client: RetrievalCoverageBanner.tsx)
 *
 * Kept together for the reason artifactElision.ts records: the same signal authored separately in
 * two voices drifts, and a wording fix in one leaves the other saying something subtly different.
 *
 * Deliberately does not name internal limits or document ids. A user cannot act on "the 4000-chunk
 * per-turn scan budget", but they can act on "ask a narrower question"; the diagnostic detail stays
 * in `promptMeta.warnings` for the Prompt Meta Inspector.
 */

/**
 * The one line shown under the reply. Reads as a note, not an error: the hazard is not an
 * unanswered question but a confident "there is nothing in the library about X" drawn from a scan
 * that never reached most of the library, and a single quiet line is enough to prevent that.
 */
export const COVERAGE_BANNER_TITLE = 'Searched part of your library, so this answer may be incomplete.';

/**
 * First line of the disclosure. Names the specific false conclusion the notice exists to prevent;
 * it sits behind the disclosure so the line above can stay short.
 */
export const COVERAGE_BANNER_BODY = 'This is not proof that nothing else in the library is relevant.';

/** Label for the disclosure that reveals the reasons. */
export const COVERAGE_BANNER_DETAILS_LABEL = 'Details';
