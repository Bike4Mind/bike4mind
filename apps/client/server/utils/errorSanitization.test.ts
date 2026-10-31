import { describe, expect, it } from 'vitest';
import { BadRequestError, HTTPError, TooManyRequestsError } from '@bike4mind/common';
import { cliCompletionErrorFields } from './errorSanitization';

describe('cliCompletionErrorFields', () => {
  it('forwards errorCode and a numeric retryAfter from a 429', () => {
    const error = new TooManyRequestsError('Daily limit', { errorCode: 'daily_free_limit_reached', retryAfter: 120 });
    expect(cliCompletionErrorFields(error)).toEqual({
      error: 'Daily limit',
      errorCode: 'daily_free_limit_reached',
      retryAfter: 120,
      status: 429,
    });
  });

  it('omits retryAfter when it is not a number', () => {
    const error = new TooManyRequestsError('Slow down', { retryAfter: 'soon' });
    expect(cliCompletionErrorFields(error)).toEqual({ error: 'Slow down', status: 429 });
  });

  it('keeps errorCode on other 4xx errors without a retryAfter', () => {
    const error = new BadRequestError('Bad', { errorCode: 'invalid_request' });
    expect(cliCompletionErrorFields(error)).toEqual({ error: 'Bad', errorCode: 'invalid_request', status: 400 });
  });

  it('keeps errorCode and status on a 5xx but sanitizes its message', () => {
    const error = new HTTPError(503, 'Failed to create LLM backend for model: secret', {
      errorCode: 'provider_not_configured',
    });
    expect(cliCompletionErrorFields(error)).toEqual({
      error: 'Internal server error',
      errorCode: 'provider_not_configured',
      status: 503,
    });
  });

  it('sanitizes non-HTTP errors', () => {
    expect(cliCompletionErrorFields(new Error('db password leaked'))).toEqual({ error: 'Internal server error' });
  });
});
