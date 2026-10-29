import { DAILY_FREE_LIMIT_REACHED_ERROR_CODE } from './apiErrorCodes';
import { UnprocessableEntityError } from './errors';
import { QUEST_ERROR_CODES, QuestErrorCode } from './types';

/** A 422 tagged with the `insufficient_credits` classifier so callers can render the Add Credits CTA. */
export function insufficientCreditsError(message: string): UnprocessableEntityError {
  return new UnprocessableEntityError(message, { errorCode: 'insufficient_credits' satisfies QuestErrorCode });
}

/**
 * A 422 tagged with the `spend_cap_exceeded` classifier. Distinct from
 * `insufficient_credits`: the org is solvent, but this embed key hit its
 * admin-set spend ceiling - the remediation is the key owner raising or
 * clearing the cap, not adding credits.
 */
export function spendCapExceededError(message: string): UnprocessableEntityError {
  return new UnprocessableEntityError(message, { errorCode: 'spend_cap_exceeded' satisfies QuestErrorCode });
}

/** Reads back the classifier set by the tagged-error helpers above; `undefined` for untagged errors. */
export function getQuestErrorCode(error: unknown): QuestErrorCode | undefined {
  const code = (error as { additionalInfo?: { errorCode?: unknown } } | null)?.additionalInfo?.errorCode;
  return typeof code === 'string' && (QUEST_ERROR_CODES as readonly string[]).includes(code)
    ? (code as QuestErrorCode)
    : undefined;
}

/**
 * A credit refusal raised before any provider call that a redelivery cannot clear: the owner must buy
 * credits, or the free-tier daily cap (`daily_free_limit_reached`) must reset at UTC midnight. Background
 * workers consume the message on these instead of rethrowing into retries, the DLQ and the error alert.
 */
export function isTerminalCreditRefusal(error: unknown): boolean {
  const code = (error as { additionalInfo?: { errorCode?: unknown } } | null)?.additionalInfo?.errorCode;
  return code === 'insufficient_credits' || code === DAILY_FREE_LIMIT_REACHED_ERROR_CODE;
}
