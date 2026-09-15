/**
 * The canonical end-of-generation vocabulary, shared by every surface that has to tell a
 * finished reply from a cut-off one.
 *
 * It lives in `common` specifically because the two consumers cannot share anything
 * heavier: the normalizers that PRODUCE these values are in `@bike4mind/llm-adapters`
 * (`stopReason.ts`), but the browser bundle must not import that package - it carries the
 * provider SDKs - so the client previously hand-copied the set with a "must stay in sync"
 * comment. A third copy in the CLI would have made the drift certain, which is how a
 * truncated CLI reply went unreported in the first place.
 *
 * Values are what `CompletionInfo.stopReason` carries after normalization. Anthropic's
 * native vocabulary passes through directly; other providers are mapped onto it.
 */

/** Stop reasons meaning the model finished its turn normally. */
export const CLEAN_FINISH_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop', 'tool_use', 'stop_sequence']);

/** Generation was cut off against the output-token ceiling. */
export const TRUNCATED_FINISH_REASON = 'max_tokens';

/**
 * We aborted the stream ourselves because it degenerated into repetition
 * (`DEGENERATE_STREAM_STOP_REASON` in `@bike4mind/llm-adapters`). Distinct from
 * `max_tokens` because the useful advice differs: telling a user to continue is actively
 * wrong here, since resuming from a degenerated tail tends to reproduce the loop.
 */
export const DEGENERATE_FINISH_REASON = 'degenerate_repetition';

/**
 * Every reason meaning "this reply stopped early". Membership rather than equality with a
 * single literal, so a newly-added early-stop reason surfaces a notice automatically.
 */
export const EARLY_STOP_FINISH_REASONS: ReadonlySet<string> = new Set([
  TRUNCATED_FINISH_REASON,
  DEGENERATE_FINISH_REASON,
]);

/**
 * Whether a reply stopped early, given the reason reported for it.
 *
 * An ABSENT reason is NOT an early stop. Plenty of paths never report one (a backend whose
 * complete() leaves it unset, an older server, a non-terminal chunk), and treating silence
 * as truncation would cry wolf on every one of them. Only a reason we recognize as an
 * early stop counts - an unrecognized value is left alone rather than guessed at.
 */
export function isEarlyStop(stopReason: string | undefined | null): boolean {
  return !!stopReason && EARLY_STOP_FINISH_REASONS.has(stopReason);
}
