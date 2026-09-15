import { describe, it, expect } from 'vitest';
import { computeRealtimeVoiceUsd, isRealtimeVoiceTier } from '../realtimeVoicePricing';
import { ModelPriceTier } from '../types/entities/ModelPriceTypes';

// The gpt-realtime-1.5 rates the settlement handler hardcoded pre-catalog.
const TIER = {
  input: 4 / 1_000_000,
  cache_read: 0.4 / 1_000_000,
  output: 16 / 1_000_000,
  audio_input: 32 / 1_000_000,
  audio_cache_read: 0.4 / 1_000_000,
  audio_output: 64 / 1_000_000,
};

const USAGE = {
  textInputTokens: 1000,
  textCachedInputTokens: 500,
  textOutputTokens: 200,
  audioInputTokens: 3000,
  audioCachedInputTokens: 1000,
  audioOutputTokens: 800,
};

describe('computeRealtimeVoiceUsd', () => {
  it('sums all six components at their tier rates', () => {
    const expected =
      TIER.input * 1000 +
      TIER.cache_read * 500 +
      TIER.output * 200 +
      TIER.audio_input * 3000 +
      TIER.audio_cache_read * 1000 +
      TIER.audio_output * 800;
    expect(computeRealtimeVoiceUsd(TIER, USAGE)).toBeCloseTo(expected, 12);
  });

  it('charges cached tokens at the full input rate when the cached rate is absent (fail-safe, never free)', () => {
    const { cache_read: _cr, audio_cache_read: _acr, ...noCachedRates } = TIER;
    const expected =
      TIER.input * 1000 +
      TIER.input * 500 +
      TIER.output * 200 +
      TIER.audio_input * 3000 +
      TIER.audio_input * 1000 +
      TIER.audio_output * 800;
    expect(computeRealtimeVoiceUsd(noCachedRates, USAGE)).toBeCloseTo(expected, 12);
  });

  it('returns 0 for a zero-usage session', () => {
    const zero = {
      textInputTokens: 0,
      textCachedInputTokens: 0,
      textOutputTokens: 0,
      audioInputTokens: 0,
      audioCachedInputTokens: 0,
      audioOutputTokens: 0,
    };
    expect(computeRealtimeVoiceUsd(TIER, zero)).toBe(0);
  });
});

describe('isRealtimeVoiceTier', () => {
  it('accepts a tier carrying positive text and audio rates', () => {
    expect(isRealtimeVoiceTier(TIER)).toBe(true);
  });

  it('rejects a text-only tier (audio usage would settle at zero)', () => {
    expect(isRealtimeVoiceTier({ input: 4e-6, output: 16e-6 })).toBe(false);
  });

  it('rejects zeroed audio rates', () => {
    expect(isRealtimeVoiceTier({ ...TIER, audio_input: 0 })).toBe(false);
  });
});

describe('ModelPriceTier audio fields', () => {
  it('parses audio rates and keeps them optional', () => {
    expect(ModelPriceTier.parse(TIER)).toEqual(TIER);
    expect(ModelPriceTier.parse({ input: 1e-6, output: 2e-6 })).toEqual({ input: 1e-6, output: 2e-6 });
  });

  it('rejects negative audio rates', () => {
    expect(() => ModelPriceTier.parse({ ...TIER, audio_output: -1 })).toThrow();
  });
});
