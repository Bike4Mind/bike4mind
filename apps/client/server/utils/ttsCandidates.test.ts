import { describe, expect, it } from 'vitest';
import { estimateTtsCreditCost, TTS_MAX_INPUT_CHARS } from '@bike4mind/common';
import { estimateTtsHoldCredits, ttsCandidates } from './ttsCandidates';

describe('TTS candidate holds', () => {
  it.each(['openai', 'elevenlabs'] as const)('covers the pricier vendor when requesting %s', provider => {
    expect(estimateTtsHoldCredits(provider, undefined, 1000)).toBe(
      estimateTtsCreditCost('elevenlabs', 'eleven_multilingual_v2', 1000)
    );
  });

  it('uses the requested model rate when it exceeds the alternate rate', () => {
    expect(estimateTtsHoldCredits('elevenlabs', 'eleven_flash_v2_5', 1000)).toBe(
      estimateTtsCreditCost('elevenlabs', 'eleven_flash_v2_5', 1000)
    );
  });

  it('retains candidates at their input ceiling and excludes them above it', () => {
    const maxOpenAiCharacters = TTS_MAX_INPUT_CHARS.openai;
    expect(ttsCandidates('elevenlabs', maxOpenAiCharacters)).toEqual(['elevenlabs', 'openai']);
    expect(ttsCandidates('elevenlabs', maxOpenAiCharacters + 1)).toEqual(['elevenlabs']);
    expect(estimateTtsHoldCredits('elevenlabs', undefined, maxOpenAiCharacters + 1)).toBe(
      estimateTtsCreditCost('elevenlabs', 'eleven_multilingual_v2', maxOpenAiCharacters + 1)
    );
  });

  it('uses conservative pricing for an unknown requested model', () => {
    expect(estimateTtsHoldCredits('elevenlabs', 'unknown-model', 1000)).toBe(
      estimateTtsCreditCost('elevenlabs', 'unknown-model', 1000)
    );
  });
});
