import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { GENERATION_ACCOUNT_CANNOT_PAY_MESSAGE, GENERATION_RATE_LIMITED_MESSAGE } from './generationErrors';
import { describeMusicGenerationError, isMusicNotCancellableError } from './musicGenerationErrors';

const FALLBACK = 'Could not start the song. Try again.';

const axiosError = (status: number, data: unknown): AxiosError =>
  new AxiosError('request failed', String(status), undefined, undefined, {
    status,
    statusText: '',
    data,
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

describe('describeMusicGenerationError', () => {
  it('maps a refusal code to its message and never shows the server text', () => {
    const message = describeMusicGenerationError(
      axiosError(422, { errorCode: 'unsupported_vocals', error: 'raw provider text' }),
      FALLBACK
    );
    expect(message).toBe('This model only makes instrumental music.');
  });

  it('explains a full storage quota', () => {
    const storage = {
      errorCode: 'storage_limit_exceeded',
      used_bytes: 10,
      limit_bytes: 10,
      requested_bytes: 1,
      owner: 'user',
    };
    expect(describeMusicGenerationError(axiosError(400, storage), FALLBACK)).toBe(
      'Your file storage is full. Free up space in Files, then try again.'
    );
  });

  it('uses the rate-limit message for a 429', () => {
    expect(describeMusicGenerationError(axiosError(429, {}), FALLBACK)).toBe(GENERATION_RATE_LIMITED_MESSAGE);
  });

  it('falls back for an unknown code or a non-HTTP error', () => {
    expect(describeMusicGenerationError(axiosError(500, { errorCode: 'mystery' }), FALLBACK)).toBe(FALLBACK);
    expect(describeMusicGenerationError(new Error('boom'), FALLBACK)).toBe(FALLBACK);
  });
});

describe('isMusicNotCancellableError', () => {
  it('is true only for a 409 carrying the not_cancellable code', () => {
    expect(isMusicNotCancellableError(axiosError(409, { errorCode: 'not_cancellable' }))).toBe(true);
    expect(isMusicNotCancellableError(axiosError(409, { errorCode: 'other' }))).toBe(false);
    expect(isMusicNotCancellableError(axiosError(500, { errorCode: 'not_cancellable' }))).toBe(false);
  });

  it('is false for a body it cannot read or a non-HTTP error', () => {
    expect(isMusicNotCancellableError(axiosError(409, null))).toBe(false);
    expect(isMusicNotCancellableError(axiosError(409, 'not_cancellable'))).toBe(false);
    expect(isMusicNotCancellableError(new Error('boom'))).toBe(false);
  });
});

describe('describeMusicGenerationError billing context', () => {
  const personal = { name: 'Me', personal: true };
  const org = { name: 'Acme', personal: false };
  const insufficient = () => axiosError(422, { error: 'x', errorCode: 'insufficient_credits' });

  it('tells the user to switch accounts on a 403 while an organization account is billed', () => {
    expect(describeMusicGenerationError(axiosError(403, { error: 'x' }), FALLBACK, org)).toBe(
      GENERATION_ACCOUNT_CANNOT_PAY_MESSAGE
    );
  });

  it('keeps the fallback for a 403 on a personal or unselected account, which sends no organization', () => {
    const forbidden = axiosError(403, { error: 'x' });
    expect(describeMusicGenerationError(forbidden, FALLBACK, personal)).toBe(FALLBACK);
    expect(describeMusicGenerationError(forbidden, FALLBACK, null)).toBe(FALLBACK);
  });

  it('keeps the fallback for a 403 without billing context', () => {
    expect(describeMusicGenerationError(axiosError(403, { error: 'x' }), FALLBACK)).toBe(FALLBACK);
  });

  it('names the paying account when credits run out', () => {
    expect(describeMusicGenerationError(insufficient(), FALLBACK, personal)).toBe(
      'Your personal credits are not enough for this song.'
    );
    expect(describeMusicGenerationError(insufficient(), FALLBACK, org)).toBe(
      'Acme does not have enough credits for this song.'
    );
    expect(describeMusicGenerationError(insufficient(), FALLBACK, null)).toBe(
      'You do not have enough credits for this song.'
    );
  });

  it('lets a rate limit win over the billing message', () => {
    expect(describeMusicGenerationError(axiosError(429, {}), FALLBACK, org)).toBe(GENERATION_RATE_LIMITED_MESSAGE);
  });

  it('reports full storage rather than the account message when an organization account is billed', () => {
    const storage = {
      errorCode: 'storage_limit_exceeded',
      used_bytes: 10,
      limit_bytes: 10,
      requested_bytes: 1,
      owner: 'user',
    };

    expect(describeMusicGenerationError(axiosError(403, storage), FALLBACK, org)).toBe(
      'Your file storage is full. Free up space in Files, then try again.'
    );
  });
});
