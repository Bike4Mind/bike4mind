/**
 * User-facing copy for the partial-grounding-coverage affordance.
 *
 * Single source of truth for the two surfaces that report the same underlying signal:
 *  - server: the `promptMeta.warnings` entry built by reportCoverage (services:
 *    ChatCompletionFeatures.ts), which interpolates the machine-readable reasons
 *  - chat: the `retrieval-coverage-warning` banner (client: RetrievalCoverageBanner.tsx)
 *
 * Kept together for the reason artifactElision.ts records: the same signal authored separately in
 * two voices drifts, and a wording fix in one leaves the other saying something subtly different.
 *
 * The server string is diagnostic and names the caps it hit; this copy is the reader-facing half
 * and deliberately does not. A user cannot act on "the 4000-chunk per-turn scan budget", but they
 * can act on "ask a narrower question" - the reasons stay available underneath for the cases that
 * ARE actionable (a document still re-indexing, a document embedded with another model).
 */

/** Chat banner heading. States the limit as a fact - unlike elision, this is not a heuristic. */
export const COVERAGE_BANNER_TITLE = 'Only part of your library was searched';

/**
 * Chat banner body. Names the specific false conclusion this banner exists to prevent: the hazard
 * is not an unanswered question, it is a confident "there is nothing in the library about X"
 * drawn from a scan that never reached most of the library.
 */
export const COVERAGE_BANNER_BODY =
  'This answer is grounded in a partial scan of your knowledge base, so treat it as incomplete - ' +
  'and in particular, do not read it as proof that nothing else in the library is relevant.';

/** Label for the disclosure that reveals the per-reason detail. */
export const COVERAGE_BANNER_DETAILS_LABEL = 'Why the scan was partial';
