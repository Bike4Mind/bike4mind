import { describe, it, expect } from 'vitest';
import { computeTtsUsd, ttsUsdPer1kChars } from './voicePricing';

describe('ttsUsdPer1kChars', () => {
  it('returns the per-model rate for known OpenAI models', () => {
    expect(ttsUsdPer1kChars('openai', 'tts-1')).toBe(0.015);
    expect(ttsUsdPer1kChars('openai', 'tts-1-hd')).toBe(0.03);
  });

  it('returns the per-model rate for known ElevenLabs models', () => {
    expect(ttsUsdPer1kChars('elevenlabs', 'eleven_multilingual_v2')).toBe(0.1);
    expect(ttsUsdPer1kChars('elevenlabs', 'eleven_turbo_v2_5')).toBe(0.05);
  });

  it('falls back to the highest vendor rate for an unknown/undefined model (never free)', () => {
    expect(ttsUsdPer1kChars('openai', 'some-future-model')).toBe(0.03);
    expect(ttsUsdPer1kChars('openai', undefined)).toBe(0.03);
    expect(ttsUsdPer1kChars('elevenlabs', 'eleven_unknown')).toBe(0.1);
  });
});

describe('computeTtsUsd', () => {
  it('prices per input character', () => {
    // 1000 chars * $0.015/1k = $0.015
    expect(computeTtsUsd('openai', 'tts-1', 1000)).toBeCloseTo(0.015, 6);
    // 500 chars * $0.10/1k = $0.05
    expect(computeTtsUsd('elevenlabs', 'eleven_multilingual_v2', 500)).toBeCloseTo(0.05, 6);
  });

  it('returns 0 for non-positive or non-finite character counts', () => {
    expect(computeTtsUsd('openai', 'tts-1', 0)).toBe(0);
    expect(computeTtsUsd('openai', 'tts-1', -5)).toBe(0);
    expect(computeTtsUsd('openai', 'tts-1', Number.NaN)).toBe(0);
  });

  it('charges the conservative fallback rate for an unknown model rather than nothing', () => {
    expect(computeTtsUsd('elevenlabs', 'eleven_unknown', 1000)).toBeCloseTo(0.1, 6);
  });
});
