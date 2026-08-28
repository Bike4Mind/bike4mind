/**
 * The abstention block a forced-retrieval turn falls back to when it grounds nothing.
 *
 * Split out of `ChatCompletionFeatures.ts` so the text is directly testable (and consumable by the
 * behaviour eval in `evals/`) without pulling in that module's Mongo / embedding-factory graph. The
 * only consumer in production is `ForcedRetrievalFeature.noContextMessages`.
 */

export type ForcedRetrievalNoContextFinding = 'unavailable' | 'no_match_partial' | 'no_match';

/**
 * Common to all three findings below. Every instruction here and in the finding bodies is
 * conditional on the request actually depending on the library - forced retrieval is a per-session
 * toggle on ordinary chats, so a greeting or a "make that shorter" must not become a refusal.
 */
export const FORCED_RETRIEVAL_NO_CONTEXT_RULES =
  'For any part of the answer that depends on that library, do not fill the gap from general knowledge or ' +
  'from assumptions about the user, their organization, or their data, and never invent sources, citations, ' +
  'or figures. If answering needs information you do not have, say what is missing and ask for it - here ' +
  'that is a correct and useful answer, not a failure to deliver.';

/**
 * The abstention block that replaces retrieved context when a forced-retrieval turn grounds nothing.
 * Returning an empty array used to be read as "the model will refuse", but nothing ever told it to:
 * with no context and no instruction, a grounded surface answers from parametric knowledge and
 * fills the gaps with assumptions about the caller - the worst outcome a citation-enforced product
 * has.
 *
 * Three findings, because the model relays this to the user as fact and only one of the three
 * supports "the library does not cover this":
 * - `unavailable` - nothing was searchable (repo missing, search threw, no readable documents, no
 *   vectorized chunks). Saying the library lacks coverage here is a claim the turn never earned;
 *   an outage would read to the user as a missing document.
 * - `no_match_partial` - a real search ran but coverage was cut short (candidate cap, chunk budget,
 *   embedding-model mismatch), so "nothing matched" must not harden into "nothing exists". Mirrors
 *   the coverageNote hedge on the success path.
 * - `no_match` - the whole accessible library was searched and nothing cleared the relevance floor.
 *   Only here is a flat "not covered" honest.
 *
 * Deliberately NOT emitted for the two non-failures: an empty prompt, and a turn carrying attached
 * files (where skipping lake retrieval is the intended behaviour and the attachment is the source).
 */
export function forcedRetrievalNoContextPrompt(finding: ForcedRetrievalNoContextFinding): string {
  const body =
    finding === 'unavailable'
      ? 'The curated library could not be searched for this question - it is unavailable, or it holds no ' +
        'documents that could be searched for you on this turn. If the request depends on that library, say ' +
        'it could not be consulted. Do NOT say or imply the library lacks coverage of the topic; this turn ' +
        'established no such thing.'
      : finding === 'no_match_partial'
        ? 'Only part of the curated library could be searched for this question, and nothing in the part that ' +
          'was searched matched. If the request depends on that library, say the search turned up nothing. Do ' +
          'NOT state or imply the library has no coverage of the topic - the search was incomplete.'
        : 'The curated library was searched for this question and returned nothing relevant. If the request ' +
          'depends on that library, say plainly that it does not cover this.';
  return `[Knowledge Base - No Retrieved Context]\n${body} ${FORCED_RETRIEVAL_NO_CONTEXT_RULES}`;
}
