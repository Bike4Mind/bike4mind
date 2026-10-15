import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { GENERATION_RATE_LIMITED_MESSAGE } from './generationErrors';
import { describeMusicGenerationError } from './musicGenerationErrors';

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
