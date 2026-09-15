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
