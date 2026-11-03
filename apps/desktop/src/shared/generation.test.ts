import { describe, expect, it } from 'vitest';
import { normalizeGeneration, requestGeneration, type ModelControls } from './generation';

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
