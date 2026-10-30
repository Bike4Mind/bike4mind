import { describe, expect, it } from 'vitest';
import { BadRequestError, TooManyRequestsError } from '@bike4mind/common';
import { cliCompletionErrorFields } from './errorSanitization';

describe('cliCompletionErrorFields', () => {
  it('forwards errorCode and a numeric retryAfter from a 429', () => {
    const error = new TooManyRequestsError('Daily limit', { errorCode: 'daily_free_limit_reached', retryAfter: 120 });
    expect(cliCompletionErrorFields(error)).toEqual({
      error: 'Daily limit',
      errorCode: 'daily_free_limit_reached',
      retryAfter: 120,
    });
  });

  it('omits retryAfter when it is not a number', () => {
    const error = new TooManyRequestsError('Slow down', { retryAfter: 'soon' });
    expect(cliCompletionErrorFields(error)).toEqual({ error: 'Slow down' });
  });

  it('keeps errorCode on other 4xx errors without a retryAfter', () => {
    const error = new BadRequestError('Bad', { errorCode: 'invalid_request' });
    expect(cliCompletionErrorFields(error)).toEqual({ error: 'Bad', errorCode: 'invalid_request' });
  });

  it('sanitizes non-4xx errors', () => {
    expect(cliCompletionErrorFields(new Error('db password leaked'))).toEqual({ error: 'Internal server error' });
  });
});
