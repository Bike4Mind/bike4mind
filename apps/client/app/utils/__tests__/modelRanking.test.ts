import { describe, it, expect } from 'vitest';
import { calculateModelScore, sortModelsByCapability } from '../modelRanking';
import { ModelBackend } from '@bike4mind/common';

// Minimal model factory for testing family score behavior
function createModel(
  overrides: Partial<{
    id: string;
    name: string;
    backend: string;
    contextWindow: number;
    max_tokens: number;
    supportsTools: boolean;
    supportsVision: boolean;
    pricing: Record<number, { input: number; output: number }>;
    rank: number;
    trainingCutoff: string;
    type: string;
  }>
) {
  return {
    id: overrides.id ?? 'test-model',
    type: overrides.type ?? 'text',
    name: overrides.name ?? overrides.id ?? 'test-model',
    backend: overrides.backend ?? ModelBackend.Anthropic,
    contextWindow: overrides.contextWindow ?? 200000,
    max_tokens: overrides.max_tokens ?? 8192,
    supportsTools: overrides.supportsTools ?? true,
    supportsVision: overrides.supportsVision ?? true,
    supportsImageVariation: false,
    pricing: overrides.pricing ?? { 200000: { input: 0.001, output: 0.005 } },
    rank: overrides.rank,
    trainingCutoff: overrides.trainingCutoff,
  } as Parameters<typeof calculateModelScore>[0];
}

describe('calculateModelScore', () => {
  // All tests use a shared allModels array for normalization
  const allModels = [
    createModel({ id: 'norm-1', contextWindow: 200000, max_tokens: 8192 }),
    createModel({ id: 'norm-2', contextWindow: 100000, max_tokens: 4096 }),
  ];

  describe('Claude 4.x family scoring', () => {
    it('should score Claude 4.x Opus at 1.0 family score', () => {
      const opus = createModel({ name: 'Claude 4.5 Opus' });
      const score = calculateModelScore(opus, allModels);
      // familyScore=1.0, weight=0.35, so family contribution = 0.35
      expect(score).toBeGreaterThan(0.8);
    });

    it('should score Claude 4.x Sonnet at 0.97 family score', () => {
      const sonnet = createModel({ name: 'Claude 4.6 Sonnet' });
      const score = calculateModelScore(sonnet, allModels);
      expect(score).toBeGreaterThan(0.7);
    });

    it('should score Claude 4.x Haiku at 0.85 family score', () => {
      const haiku = createModel({ name: 'Claude 4.5 Haiku' });
      const score = calculateModelScore(haiku, allModels);
      expect(score).toBeGreaterThan(0.6);
    });

    it('should rank Claude 4.x Opus > Sonnet > Haiku', () => {
      const opus = createModel({ name: 'Claude 4.5 Opus' });
      const sonnet = createModel({ name: 'Claude 4.6 Sonnet' });
      const haiku = createModel({ name: 'Claude 4.5 Haiku' });

      const opusScore = calculateModelScore(opus, allModels);
      const sonnetScore = calculateModelScore(sonnet, allModels);
      const haikuScore = calculateModelScore(haiku, allModels);

      expect(opusScore).toBeGreaterThan(sonnetScore);
      expect(sonnetScore).toBeGreaterThan(haikuScore);
    });
  });

  describe('Claude 4.x vs 3.x ranking', () => {
    it('should rank Claude 4.x Sonnet higher than Claude 3.7', () => {
      const sonnet4 = createModel({ name: 'Claude 4.6 Sonnet' });
      const claude37 = createModel({ name: 'claude-3-7-sonnet' });

      const sonnet4Score = calculateModelScore(sonnet4, allModels);
      const claude37Score = calculateModelScore(claude37, allModels);

      expect(sonnet4Score).toBeGreaterThan(claude37Score);
    });

    it('should rank Claude 4.5 Haiku higher than Claude 3.5 Haiku', () => {
      const haiku45 = createModel({ name: 'Claude 4.5 Haiku' });
      const haiku35 = createModel({ name: 'claude-3-5-haiku' });

      const haiku45Score = calculateModelScore(haiku45, allModels);
      const haiku35Score = calculateModelScore(haiku35, allModels);

      expect(haiku45Score).toBeGreaterThan(haiku35Score);
    });
  });

  describe('Unrecognized models', () => {
    it('should give unrecognized models a base family score of 0.3', () => {
      const unknown = createModel({ name: 'some-unknown-model' });
      const haiku35 = createModel({ name: 'claude-3-5-haiku' });

      const unknownScore = calculateModelScore(unknown, allModels);
      const haiku35Score = calculateModelScore(haiku35, allModels);

      expect(unknownScore).toBeLessThan(haiku35Score);
    });
  });
});

describe('sortModelsByCapability', () => {
  it('should sort admin-ranked models before unranked models', () => {
    const ranked = createModel({ id: 'ranked', name: 'claude-3-5-haiku', rank: 1 });
    const unranked = createModel({ id: 'unranked', name: 'Claude 4.5 Opus' });

    const sorted = sortModelsByCapability([unranked, ranked]);
    expect(sorted[0].id).toBe('ranked');
  });

  it('should sort admin-ranked models by rank value (lower = first)', () => {
    const rank1 = createModel({ id: 'first', name: 'model-a', rank: 1 });
    const rank5 = createModel({ id: 'second', name: 'model-b', rank: 5 });

    const sorted = sortModelsByCapability([rank5, rank1]);
    expect(sorted[0].id).toBe('first');
    expect(sorted[1].id).toBe('second');
  });

  it('should sort unranked models by calculated score (higher capability first)', () => {
    const opus = createModel({ id: 'opus', name: 'Claude 4.5 Opus' });
    const haiku = createModel({ id: 'haiku', name: 'claude-3-5-haiku' });

    const sorted = sortModelsByCapability([haiku, opus]);
    expect(sorted[0].id).toBe('opus');
    expect(sorted[1].id).toBe('haiku');
  });
});
