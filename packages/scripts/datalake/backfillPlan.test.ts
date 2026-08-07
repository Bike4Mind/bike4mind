import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OpenAIEmbeddingModel } from '@bike4mind/common';

const { defaultEmbeddingModelForEnvMock } = vi.hoisted(() => ({
  defaultEmbeddingModelForEnvMock: vi.fn(() => OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002),
}));
vi.mock('@bike4mind/common', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
  return { ...actual, defaultEmbeddingModelForEnv: defaultEmbeddingModelForEnvMock };
});

import { planFileBackfills, resolveMajorityEmbeddingModel, type MissingEmbeddingChunk } from './backfillPlan.js';

const chunk = (overrides: Partial<MissingEmbeddingChunk> = {}): MissingEmbeddingChunk => ({
  id: 'c1',
  fabFileId: 'f1',
  vectorLength: 1536,
  ...overrides,
});

describe('resolveMajorityEmbeddingModel', () => {
  beforeEach(() => defaultEmbeddingModelForEnvMock.mockReturnValue(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002));

  it('returns null when there are no vectors', () => {
    expect(resolveMajorityEmbeddingModel([])).toBeNull();
  });

  it('returns null for an unregistered width', () => {
    expect(resolveMajorityEmbeddingModel([999_999, 999_999])).toBeNull();
  });

  it('resolves a single-candidate width unambiguously', () => {
    // 3072 is unique to text-embedding-3-large in the registry.
    expect(resolveMajorityEmbeddingModel([3072, 3072, 3072])).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE);
  });

  it('breaks a same-width tie by preferring the deployment default', () => {
    // 1536 is shared by ada-002 and 3-small; default is pinned to ada-002 in this test.
    expect(resolveMajorityEmbeddingModel([1536, 1536])).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('falls back to the first candidate alphabetically when the default is not a candidate', () => {
    defaultEmbeddingModelForEnvMock.mockReturnValue('some-other-model' as OpenAIEmbeddingModel);
    const result = resolveMajorityEmbeddingModel([1536, 1536]);
    expect([OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002]).toContain(
      result
    );
  });

  it('refuses to guess a mixed-width sample with no clear majority', () => {
    expect(resolveMajorityEmbeddingModel([1536, 3072])).toBeNull();
  });

  it('accepts a clear (>50%) majority even with some minority noise', () => {
    expect(resolveMajorityEmbeddingModel([3072, 3072, 3072, 1536])).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE);
  });
});

describe('planFileBackfills', () => {
  it('uses the known FabFile.embeddingModel over guessing', () => {
    const chunks = [chunk({ id: 'c1', fabFileId: 'f1' }), chunk({ id: 'c2', fabFileId: 'f1' })];
    const { plans, unresolved } = planFileBackfills(chunks, new Map([['f1', 'voyage-3']]));
    expect(unresolved).toEqual([]);
    expect(plans).toEqual([{ fabFileId: 'f1', embeddingModel: 'voyage-3', chunkCount: 2 }]);
  });

  it('falls back to the majority guess when the file has no known model', () => {
    const chunks = [chunk({ id: 'c1', fabFileId: 'f1', vectorLength: 3072 })];
    const { plans } = planFileBackfills(chunks, new Map([['f1', undefined]]));
    expect(plans).toEqual([
      { fabFileId: 'f1', embeddingModel: OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE, chunkCount: 1 },
    ]);
  });

  it('reports a file as unresolved rather than guessing wrong', () => {
    const chunks = [
      chunk({ id: 'c1', fabFileId: 'f1', vectorLength: 1536 }),
      chunk({ id: 'c2', fabFileId: 'f1', vectorLength: 3072 }),
    ];
    const { plans, unresolved } = planFileBackfills(chunks, new Map([['f1', undefined]]));
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
      ])
    );
    expect(plans.map(p => p.fabFileId).sort()).toEqual(['f1', 'f2']);
  });
});
