// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { getInsufficientCreditsMessage } from './error';

/** An axios rejection shaped like one from the shared error envelope (errorHandler.ts). */
const apiError = (status: number, data: unknown): AxiosError => {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config as never, {}, {
    status,
    statusText: '',
    data,
    headers: {},
    config,
  } as never);
};

describe('getInsufficientCreditsMessage', () => {
  it('returns the server message for a 422 tagged insufficient_credits', () => {
    const message = getInsufficientCreditsMessage(
      apiError(422, { errorCode: 'insufficient_credits', error: 'You do not have enough credits for session tagging.' })
    );

    expect(message).toBe('You do not have enough credits for session tagging.');
  });

  // Only `errorCode` distinguishes a billing state from an unrelated 422 (e.g. a Zod failure),
  // so an untagged 422 must fall through to the caller's own message.
  it('returns undefined for an untagged 422', () => {
    expect(getInsufficientCreditsMessage(apiError(422, { error: 'Validation failed' }))).toBeUndefined();
  });

  it('returns undefined for a different error code', () => {
    expect(
      getInsufficientCreditsMessage(apiError(422, { errorCode: 'spend_cap_exceeded', error: 'Cap hit' }))
    ).toBeUndefined();
  });

  it('returns undefined for a non-axios error', () => {
    expect(getInsufficientCreditsMessage(new Error('boom'))).toBeUndefined();
  });

  // The envelope writes the human text to `error`; `message` is the fallback for any route that
  // still returns the older shape. A tagged error with neither must not produce an empty toast.
  it('falls back to `message`, then to undefined when the body carries no text', () => {
    expect(getInsufficientCreditsMessage(apiError(422, { errorCode: 'insufficient_credits', message: 'Out.' }))).toBe(
      'Out.'
    );
    expect(getInsufficientCreditsMessage(apiError(422, { errorCode: 'insufficient_credits' }))).toBeUndefined();
  });
});
