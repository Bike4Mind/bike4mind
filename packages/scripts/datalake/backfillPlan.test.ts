import { describe, expect, it } from 'vitest';
import { OpenAIEmbeddingModel } from '@bike4mind/common';
import { planFileBackfills, resolveMajorityEmbeddingModel, type MissingEmbeddingChunk } from './backfillPlan.js';

const chunk = (overrides: Partial<MissingEmbeddingChunk> = {}): MissingEmbeddingChunk => ({
  id: 'c1',
  fabFileId: 'f1',
  vectorLength: 1536,
  ...overrides,
});

describe('resolveMajorityEmbeddingModel', () => {
  it('returns null when there are no vectors', () => {
    expect(resolveMajorityEmbeddingModel([], OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)).toBeNull();
  });

  it('returns null for an unregistered width', () => {
    expect(resolveMajorityEmbeddingModel([999_999, 999_999], OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)).toBeNull();
  });

  it('resolves a single-candidate width unambiguously', () => {
    // 3072 is unique to text-embedding-3-large in the registry.
    expect(resolveMajorityEmbeddingModel([3072, 3072, 3072], OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)).toBe(
      OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE
    );
  });

  it('breaks a same-width tie by preferring the caller-supplied tiebreak model', () => {
    // 1536 is shared by ada-002 and 3-small.
    expect(resolveMajorityEmbeddingModel([1536, 1536], OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)).toBe(
      OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002
    );
    expect(resolveMajorityEmbeddingModel([1536, 1536], OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL)).toBe(
      OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL
    );
  });

  it('falls back to the first candidate alphabetically when the tiebreak model is not a candidate', () => {
    const result = resolveMajorityEmbeddingModel([1536, 1536], 'some-other-model');
    expect([OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002]).toContain(
      result
    );
  });

  it('refuses to resolve an ambiguous width without an explicit tiebreak model', () => {
    // 1536 is the width ada-002 and 3-small share - the exact case that used to guess wrong from
    // an unset or wrong-space environment default. An empty tiebreak must throw, not guess.
    expect(() => resolveMajorityEmbeddingModel([1536, 1536], '')).toThrow(/explicit tiebreakModel/);
  });

  it('does not require a tiebreak model for a width with only one candidate', () => {
    expect(resolveMajorityEmbeddingModel([3072, 3072], '')).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE);
  });

  it('refuses to guess a mixed-width sample with no clear majority', () => {
    expect(resolveMajorityEmbeddingModel([1536, 3072], OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)).toBeNull();
  });

  it('accepts a clear (>50%) majority even with some minority noise', () => {
    expect(resolveMajorityEmbeddingModel([3072, 3072, 3072, 1536], OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)).toBe(
      OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE
    );
  });
});

describe('planFileBackfills', () => {
  it('uses the known FabFile.embeddingModel over guessing', () => {
    const chunks = [chunk({ id: 'c1', fabFileId: 'f1' }), chunk({ id: 'c2', fabFileId: 'f1' })];
    const { plans, unresolved } = planFileBackfills(
      chunks,
      new Map([['f1', 'voyage-3']]),
      OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002
    );
    expect(unresolved).toEqual([]);
    expect(plans).toEqual([{ fabFileId: 'f1', embeddingModel: 'voyage-3', chunkCount: 2 }]);
  });

  it('falls back to the majority guess when the file has no known model', () => {
    const chunks = [chunk({ id: 'c1', fabFileId: 'f1', vectorLength: 3072 })];
    const { plans } = planFileBackfills(
      chunks,
      new Map([['f1', undefined]]),
      OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002
    );
    expect(plans).toEqual([
      { fabFileId: 'f1', embeddingModel: OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE, chunkCount: 1 },
    ]);
  });

  it('breaks a same-width guess using the caller-supplied tiebreak model, not an environment default', () => {
    const chunks = [chunk({ id: 'c1', fabFileId: 'f1', vectorLength: 1536 })];
    const { plans } = planFileBackfills(
      chunks,
      new Map([['f1', undefined]]),
      OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL
    );
    expect(plans).toEqual([
      { fabFileId: 'f1', embeddingModel: OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, chunkCount: 1 },
    ]);
  });

  it('reports a file as unresolved rather than guessing wrong', () => {
    const chunks = [
      chunk({ id: 'c1', fabFileId: 'f1', vectorLength: 1536 }),
      chunk({ id: 'c2', fabFileId: 'f1', vectorLength: 3072 }),
    ];
    const { plans, unresolved } = planFileBackfills(
      chunks,
      new Map([['f1', undefined]]),
      OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002
    );
    expect(plans).toEqual([]);
    expect(unresolved).toEqual(['f1']);
  });

  it('groups multiple files independently', () => {
    const chunks = [
      chunk({ id: 'c1', fabFileId: 'f1', vectorLength: 1536 }),
      chunk({ id: 'c2', fabFileId: 'f2', vectorLength: 3072 }),
    ];
    const { plans } = planFileBackfills(
      chunks,
      new Map([
        ['f1', 'text-embedding-ada-002'],
        ['f2', 'text-embedding-3-large'],
      ]),
      OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002
    );
    expect(plans.map(p => p.fabFileId).sort()).toEqual(['f1', 'f2']);
  });
});
