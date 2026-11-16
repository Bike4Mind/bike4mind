import { DAILY_FREE_LIMIT_REACHED_ERROR_CODE, SPEND_FROZEN_ERROR_CODE } from './apiErrorCodes';
import { ForbiddenError, UnprocessableEntityError } from './errors';
import { QUEST_ERROR_CODES, QuestErrorCode, type ISpendFreeze, type SpendFreezeScopeType } from './types';

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

const SPEND_FROZEN_SCOPE_DETAILS = {
  User: { frozenScope: 'user', message: 'Spending is paused for this account. Contact support.' },
  Organization: {
    frozenScope: 'organization',
    message: 'Spending is paused for this organization. Contact your organization admin or support.',
  },
  apiKey: { frozenScope: 'api_key', message: 'Spending is paused for this API key. Contact support.' },
} as const satisfies Record<SpendFreezeScopeType, { frozenScope: string; message: string }>;

/**
 * A 403 tagged `spend_frozen`: an admin paused new metered spend for this scope. The freeze reason is
 * deliberately not part of the error; it stays server-side.
 */
export function spendFrozenError(freeze: Pick<ISpendFreeze, 'scopeType' | 'frozenAt'>): ForbiddenError {
  const { frozenScope, message } = SPEND_FROZEN_SCOPE_DETAILS[freeze.scopeType];
  return new ForbiddenError(message, {
    errorCode: SPEND_FROZEN_ERROR_CODE satisfies QuestErrorCode,
    frozenScope,
    frozenAt: freeze.frozenAt.toISOString(),
  });
}

export function isSpendFrozenError(error: unknown): error is ForbiddenError {
  return getQuestErrorCode(error) === SPEND_FROZEN_ERROR_CODE;
}

/** Reads back the classifier set by the tagged-error helpers above; `undefined` for untagged errors. */
export function getQuestErrorCode(error: unknown): QuestErrorCode | undefined {
  const code = (error as { additionalInfo?: { errorCode?: unknown } } | null)?.additionalInfo?.errorCode;
  return typeof code === 'string' && (QUEST_ERROR_CODES as readonly string[]).includes(code)
    ? (code as QuestErrorCode)
    : undefined;
}

/**
 * An expected credit refusal raised before any provider call that a retry cannot clear: the owner must buy
 * credits, the free-tier daily cap (`daily_free_limit_reached`) must reset at UTC midnight, or an admin must
 * lift a spend freeze (`spend_frozen`). Surface it
 * with its own status and do not log it as a fault: HTTP routes rethrow it, and background workers consume
 * the message instead of retrying into the DLQ and the error alert.
 */
export function isTerminalCreditRefusal(error: unknown): boolean {
  const code = (error as { additionalInfo?: { errorCode?: unknown } } | null)?.additionalInfo?.errorCode;
  return (
    code === 'insufficient_credits' || code === DAILY_FREE_LIMIT_REACHED_ERROR_CODE || code === SPEND_FROZEN_ERROR_CODE
  );
}
