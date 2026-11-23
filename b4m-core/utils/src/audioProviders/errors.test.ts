import { describe, expect, it } from 'vitest';
import { isCredentialRejectionResult, isQuotaExhaustedResult, toAudioProviderResult } from './errors';

// The body ElevenLabs answers with once the account has no credits left, as a 401.
const ELEVENLABS_QUOTA_BODY = JSON.stringify({
  detail: {
    type: 'invalid_request',
    code: 'quota_exceeded',
    status: 'quota_exceeded',
    message: 'This request exceeds your quota of 10000. You have 0 credits remaining, while 50 credits are required.',
  },
});

// The shape ElevenLabsSoundGenerator throws on a non-OK response.
const elevenLabsError = (status: number, detail: string) =>
  Object.assign(new Error(`ElevenLabs sound generation failed: ${status} ${detail}`), { status, detail });

const VENDOR = 'elevenlabs_sound_effect';

describe('toAudioProviderResult', () => {
  it('classifies the ElevenLabs 401 quota body as an exhausted quota, not a rejected key', () => {
    const result = toAudioProviderResult(elevenLabsError(401, ELEVENLABS_QUOTA_BODY), VENDOR);

    expect(result).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'elevenlabs_sound_effect_quota_exhausted',
      raw: { status: 401 },
    });
    expect(isQuotaExhaustedResult(result)).toBe(true);
    expect(isCredentialRejectionResult(result)).toBe(false);
  });

  it('classifies a 402 as an exhausted quota whatever the body', () => {
    const result = toAudioProviderResult(elevenLabsError(402, 'Payment Required'), VENDOR);

    expect(result).toMatchObject({ status: 'failed', retryable: false, message: `${VENDOR}_quota_exhausted` });
    expect(isQuotaExhaustedResult(result)).toBe(true);
  });

  it('classifies an OpenAI 429 insufficient_quota as an exhausted quota, not a retryable rate limit', () => {
    const openAiError = Object.assign(new Error('You exceeded your current quota'), {
      status: 429,
      code: 'insufficient_quota',
      error: { type: 'insufficient_quota', code: 'insufficient_quota' },
    });

    expect(toAudioProviderResult(openAiError, 'openai_speech')).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'openai_speech_quota_exhausted',
    });
  });

  it('keeps a real 429 rate limit retryable', () => {
    const body = JSON.stringify({ detail: { status: 'too_many_concurrent_requests' } });
    const result = toAudioProviderResult(elevenLabsError(429, body), VENDOR);

    expect(result).toMatchObject({ status: 'failed', retryable: true, message: `${VENDOR}_rate_limited` });
    expect(isQuotaExhaustedResult(result)).toBe(false);
  });

  it('keeps a plain 401 bad key a credential rejection', () => {
    const body = JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
    const result = toAudioProviderResult(elevenLabsError(401, body), VENDOR);

    expect(result).toMatchObject({ status: 'failed', retryable: false, message: `${VENDOR}_credential_rejected` });
    expect(isCredentialRejectionResult(result)).toBe(true);
    expect(isQuotaExhaustedResult(result)).toBe(false);
  });

  it('does not read a quota marker out of free text, which can echo caller input', () => {
    const body = JSON.stringify({ detail: { status: 'invalid_api_key', message: 'quota_exceeded' } });

    expect(toAudioProviderResult(elevenLabsError(401, body), VENDOR)).toMatchObject({
      message: `${VENDOR}_credential_rejected`,
    });
  });

  it('ignores a quota marker on a status that cannot mean an empty account', () => {
    const body = JSON.stringify({ detail: { status: 'quota_exceeded' } });

    expect(toAudioProviderResult(elevenLabsError(404, body), VENDOR)).toMatchObject({ message: `${VENDOR}_http_404` });
  });
});
