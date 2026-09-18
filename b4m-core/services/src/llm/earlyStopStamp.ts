import { DEGENERATE_FINISH_REASON, TRUNCATED_FINISH_REASON, type UsageEventStatus } from '@bike4mind/common';

/**
 * What a reply that stopped early carries: the user-facing warning, and the outcome recorded
 * on its billing row.
 *
 * Extracted from ChatCompletionProcess for the same reason as elisionStamp - that module is a
 * large orchestrator best tested indirectly, and this is the only thing standing between a
 * degenerate turn and a row that looks like a clean, fully-valued success.
 *
 * Pure: no I/O, no logging.
 */

export const TRUNCATION_WARNING =
  'Response was truncated against the output-token limit (max_tokens). Large artifacts may be incomplete.';

/**
 * Deliberately does not advise continuing: resuming from a degenerated tail is the very thing
 * that tends to reproduce the loop. Kept in step with the client banner copy in PromptReplies.
 */
export const DEGENERATE_WARNING =
  'Generation was stopped early because the response began repeating itself, so this reply is ' +
  'incomplete. Rephrase the request rather than asking to continue.';

export interface EarlyStopStamp {
  warning: string;
  /**
   * A degeneration abort still burned real provider tokens, so the row prices normally, but
   * 'degenerate' is what a future refund sweep would filter on. Truncation stays 'ok': the user got every
   * token they paid for, just not a finished answer.
   */
  usageEventStatus: UsageEventStatus;
}

/** Null for a clean finish, an absent reason, or any reason this layer does not classify. */
export function buildEarlyStopStamp(finishReason: string | undefined | null): EarlyStopStamp | null {
  if (finishReason === TRUNCATED_FINISH_REASON) {
    return { warning: TRUNCATION_WARNING, usageEventStatus: 'ok' };
  }
  if (finishReason === DEGENERATE_FINISH_REASON) {
    return { warning: DEGENERATE_WARNING, usageEventStatus: 'degenerate' };
  }
  return null;
}
