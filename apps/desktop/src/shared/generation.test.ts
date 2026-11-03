import { describe, expect, it } from 'vitest';
import { normalizeGeneration, parseGenerationInput, requestGeneration, type ModelControls } from './generation';

describe('normalizeGeneration', () => {
  it('keeps the known fields that hold finite numbers', () => {
    expect(normalizeGeneration({ temperature: 0.4, topK: 20, seed: 7, topP: '0.9', minP: Number.NaN })).toEqual({
      temperature: 0.4,
      topK: 20,
    });
  });

  it('answers undefined for nothing usable', () => {
    for (const raw of [undefined, null, 'hot', [0.4], {}, { topP: Infinity }]) {
      expect(normalizeGeneration(raw)).toBeUndefined();
    }
  });

  it('drops a stored value no model takes', () => {
    expect(normalizeGeneration({ temperature: 9, topK: 20.5, maxOutputTokens: 1e12, minP: 0.05 })).toEqual({
      minP: 0.05,
    });
  });
});

describe('parseGenerationInput', () => {
  it('takes a set within bounds, and an empty set that clears every override', () => {
    expect(parseGenerationInput({ temperature: 0, topK: 40, maxOutputTokens: 4096, seed: 7 })).toEqual({
      temperature: 0,
      topK: 40,
      maxOutputTokens: 4096,
    });
    expect(parseGenerationInput({})).toEqual({});
  });

  it.each([
    null,
    'hot',
    [0.4],
    { temperature: '0.4' },
    { temperature: 2.5 },
    { topP: -0.1 },
    { topK: 20.5 },
    { maxOutputTokens: 1e12 },
    { thinkingBudgetTokens: 512 },
    { temperature: 0.4, repeatPenalty: Number.NaN },
  ])('rejects the whole set for %j', raw => {
    expect(parseGenerationInput(raw)).toBeNull();
  });
});

describe('requestGeneration', () => {
  const controls: ModelControls = {
    temperature: { min: 0, max: 1, step: 0.05, scope: 'request' },
    topK: { min: 1, max: 200, step: 1, scope: 'request' },
    maxOutputTokens: { min: 256, max: 8192, step: 256, scope: 'request' },
  };

  it('sends only what the controls list, clamped and rounded', () => {
    expect(requestGeneration({ temperature: 1.5, topK: 20.6, minP: 0.05, maxOutputTokens: 100_000 }, controls)).toEqual(
      { temperature: 1, topK: 21, maxOutputTokens: 8192 }
    );
  });

  it('sends nothing for a locked control, a load-time one, or a model with no controls', () => {
    const pinned: ModelControls = {
      temperature: { min: 0, max: 2, step: 0.05, scope: 'request', locked: { value: 1, reason: 'pinned' } },
      topK: { min: 1, max: 200, step: 1, scope: 'load' },
    };
    expect(requestGeneration({ temperature: 0.2, topK: 20 }, pinned)).toEqual({});
    expect(requestGeneration({ temperature: 0.2 }, undefined)).toEqual({});
    expect(requestGeneration(undefined, controls)).toEqual({});
  });
});
