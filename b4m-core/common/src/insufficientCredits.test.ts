import { describe, it, expect } from 'vitest';
import { DAILY_FREE_LIMIT_REACHED_ERROR_CODE } from './apiErrorCodes';
import { ForbiddenError, TooManyRequestsError } from './errors';
import {
  getQuestErrorCode,
  insufficientCreditsError,
  isSpendFrozenError,
  isTerminalCreditRefusal,
  spendCapExceededError,
  spendFrozenError,
} from './insufficientCredits';

describe('isTerminalCreditRefusal', () => {
  it('is true for an insufficient_credits refusal', () => {
    expect(isTerminalCreditRefusal(insufficientCreditsError('Not enough credits'))).toBe(true);
  });

  it('is true for the free-tier daily cap refusal', () => {
    const error = new TooManyRequestsError('Daily free limit reached', {
      errorCode: DAILY_FREE_LIMIT_REACHED_ERROR_CODE,
      retryAfter: 3600,
    });
    expect(isTerminalCreditRefusal(error)).toBe(true);
  });

  it.each([
    ['a spend cap refusal', spendCapExceededError('Key spend cap reached')],
    [
      'a rate limit with another error code',
      new TooManyRequestsError('Slow down', { errorCode: 'token_rate_limit_exceeded' }),
    ],
    ['a plain Error', new Error('boom')],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'insufficient_credits'],
  ])('is false for %s', (_label, error) => {
    expect(isTerminalCreditRefusal(error)).toBe(false);
  });
});

describe('spendFrozenError', () => {
  const frozenAt = new Date('2026-11-16T10:00:00.000Z');

  it.each([
    ['apiKey', 'api_key', 'Spending is paused for this API key. Contact support.'],
    ['User', 'user', 'Spending is paused for this account. Contact support.'],
    [
      'Organization',
      'organization',
      'Spending is paused for this organization. Contact your organization admin or support.',
    ],
  ] as const)('builds a 403 for scope %s', (scopeType, frozenScope, message) => {
    const error = spendFrozenError({ scopeType, frozenAt });
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(message);
    expect(error.additionalInfo).toEqual({
      errorCode: 'spend_frozen',
      frozenScope,
      frozenAt: frozenAt.toISOString(),
    });
  });

  it('is a terminal credit refusal and a quest error code', () => {
    const error = spendFrozenError({ scopeType: 'User', frozenAt });
    expect(isTerminalCreditRefusal(error)).toBe(true);
    expect(getQuestErrorCode(error)).toBe('spend_frozen');
  });

  it('is recognised only for spend_frozen errors', () => {
    expect(isSpendFrozenError(spendFrozenError({ scopeType: 'User', frozenAt }))).toBe(true);
    expect(isSpendFrozenError(new ForbiddenError('x'))).toBe(false);
    expect(isSpendFrozenError(null)).toBe(false);
  });
});
