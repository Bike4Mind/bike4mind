import { describe, expect, it } from 'vitest';
import { performanceFromPromptMeta } from './performanceFromPromptMeta';

describe('performanceFromPromptMeta', () => {
  it('maps both TTFVT timings and model inference through', () => {
    const result = performanceFromPromptMeta(
      { firstTokenTime: 12_000, firstChunkTime: 800, modelInferenceTime: 9_000 },
      13_000
    );

    expect(result).toEqual({
      totalResponseTimeMs: 13_000,
      modelInferenceMs: 9_000,
      firstTokenTimeMs: 12_000,
      firstChunkTimeMs: 800,
    });
  });

  // The regression this helper exists to prevent: dropping the TTFVT pair at the call site
  // left firstTokenTimeMs undefined in production, so the slow-first-token anomaly could
  // never fire. An absent firstTokenTime must stay absent (never-rendered), not become 0.
  it('forwards a never-rendered turn as an absent firstTokenTime', () => {
    const result = performanceFromPromptMeta({ firstChunkTime: 800 }, 13_000);

    expect(result.firstChunkTimeMs).toBe(800);
    expect(result.firstTokenTimeMs).toBeUndefined();
    expect(Object.keys(result)).toContain('firstTokenTimeMs');
  });

  it('carries only totalResponseTimeMs for an undefined promptMeta.performance', () => {
    const result = performanceFromPromptMeta(undefined, 5_000);

    expect(result.totalResponseTimeMs).toBe(5_000);
    expect(result.firstTokenTimeMs).toBeUndefined();
    expect(result.firstChunkTimeMs).toBeUndefined();
    expect(result.modelInferenceMs).toBeUndefined();
  });
});
