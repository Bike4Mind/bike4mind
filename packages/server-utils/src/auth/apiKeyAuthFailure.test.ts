import { describe, expect, it, vi } from 'vitest';
import {
  ForbiddenError,
  HTTPError,
  InternalServerError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '@bike4mind/common';
import {
  authInfraFailureHeaders,
  authRetryAfterSeconds,
  isAuthInfraFailure,
  setAuthInfraFailureHeaders,
  toApiKeyAuthError,
} from './apiKeyAuthFailure';

const networkError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:27017'), { name: 'MongoNetworkError' });

describe('toApiKeyAuthError', () => {
  it('passes a credential verdict through unchanged', () => {
    const unauthorized = new UnauthorizedError('Invalid or expired API key');
    const forbidden = new ForbiddenError('suspended');

    expect(toApiKeyAuthError(unauthorized)).toBe(unauthorized);
    expect(toApiKeyAuthError(forbidden)).toBe(forbidden);
  });

  it('maps a lost database connection to a 503 with retryAfter and no driver text', () => {
    const mapped = toApiKeyAuthError(networkError);

    expect(mapped).toBeInstanceOf(ServiceUnavailableError);
    expect(mapped.statusCode).toBe(503);
    expect(mapped.message).toBe('Authentication temporarily unavailable');
    expect(authRetryAfterSeconds(mapped)).toBe(5);
  });

  it('maps any other error to a fixed-message 500', () => {
    const mapped = toApiKeyAuthError(new TypeError('Cannot read properties of undefined (reading host)'));

    expect(mapped).toBeInstanceOf(InternalServerError);
    expect(mapped.statusCode).toBe(500);
    expect(mapped.message).toBe('Authentication failed');
  });
});

describe('isAuthInfraFailure', () => {
  it('is true only for a 5xx HTTPError', () => {
    expect(isAuthInfraFailure(toApiKeyAuthError(networkError))).toBe(true);
    expect(isAuthInfraFailure(toApiKeyAuthError('boom'))).toBe(true);
    expect(isAuthInfraFailure(new UnauthorizedError('nope'))).toBe(false);
    expect(isAuthInfraFailure(new HTTPError(429, 'slow down'))).toBe(false);
    expect(isAuthInfraFailure(networkError)).toBe(false);
  });
});

describe('authInfraFailureHeaders', () => {
  it('carries Retry-After only when the error has a retryAfter', () => {
    expect(authInfraFailureHeaders(toApiKeyAuthError(networkError))).toEqual({ 'Retry-After': '5' });
    expect(authInfraFailureHeaders(toApiKeyAuthError('boom'))).toEqual({});
  });

  it('sets the headers on a response', () => {
    const res = { setHeader: vi.fn() };

    setAuthInfraFailureHeaders(res, toApiKeyAuthError(networkError));

    expect(res.setHeader).toHaveBeenCalledExactlyOnceWith('Retry-After', '5');
  });
});
