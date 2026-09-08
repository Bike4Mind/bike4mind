import { describe, it, expect } from 'vitest';
import { computeTtsUsd, usdToCredits } from '@bike4mind/common';
import { estimateAudioCredits } from './index';
import { estimateSoundCredits } from '../soundCost';

describe('estimateAudioCredits', () => {
  it('speech charge equals usdToCredits(computeTtsUsd(...)) - identical to the /api/ai/tts endpoint', () => {
    const provider = 'openai';
    const model = 'tts-1';
    const characters = 4096;

    const { requiredCredits, usdCost, units } = estimateAudioCredits({
      kind: 'speech',
      provider,
      model,
      characters,
    });

    // Same math deductTtsCredits uses, so a tool synthesis bills like a direct one.
    expect(usdCost).toBe(computeTtsUsd(provider, model, characters));
    expect(requiredCredits).toBe(usdToCredits(computeTtsUsd(provider, model, characters)));
    expect(units).toBe(characters);
  });

  it('falls back to the vendor rate table when the model is unknown (conservative gate estimate)', () => {
    const withModel = estimateAudioCredits({ kind: 'speech', provider: 'openai', model: 'tts-1', characters: 1000 });
    const withoutModel = estimateAudioCredits({ kind: 'speech', provider: 'openai', characters: 1000 });
    // The fallback rate is the highest known rate, so an unknown model never bills below a known one.
    expect(withoutModel.requiredCredits).toBeGreaterThanOrEqual(withModel.requiredCredits);
  });

  it('sound-effect charge delegates to estimateSoundCredits and reports billed seconds as units', () => {
    const durationSeconds = 10;
    const direct = estimateSoundCredits('elevenlabs', { durationSeconds });

    const { requiredCredits, usdCost, units } = estimateAudioCredits({
      kind: 'sound_effect',
      provider: 'elevenlabs',
      durationSeconds,
    });

    expect(requiredCredits).toBe(direct.requiredCredits);
    expect(usdCost).toBe(direct.usdCost);
    expect(units).toBe(direct.billedSeconds);
  });
});
