import { describe, it, expect } from 'vitest';
import { DAILY_FREE_LIMIT_REACHED_ERROR_CODE } from './apiErrorCodes';
import { TooManyRequestsError } from './errors';
import { insufficientCreditsError, isTerminalCreditRefusal, spendCapExceededError } from './insufficientCredits';

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
