import { describe, expect, it, vi } from 'vitest';
import { createReachableSourcesResolver, isFabFileCitable, type CitableFileFields } from './lakeSourceReachability';

const citableFile = (over: Partial<CitableFileFields> = {}): CitableFileFields => ({
  id: 'f1',
  fileName: 'spec.pdf',
  chunkCount: 3,
  vectorizedChunkCount: 3,
  embeddingModel: 'text-embedding-3-small',
  vectorized: true,
  deletedAt: undefined,
  archivedAt: undefined,
  ...over,
});

const QUERY_MODEL = 'text-embedding-3-small';

describe('isFabFileCitable', () => {
  it('is citable when live, fully vectorized, and in the query vector space', () => {
    expect(isFabFileCitable(citableFile(), { queryEmbeddingModel: QUERY_MODEL })).toBe(true);
  });

  it('is not citable when soft-deleted or archived', () => {
    expect(isFabFileCitable(citableFile({ deletedAt: new Date() }), { queryEmbeddingModel: QUERY_MODEL })).toBe(false);
    expect(isFabFileCitable(citableFile({ archivedAt: new Date() }), { queryEmbeddingModel: QUERY_MODEL })).toBe(false);
  });

  it('is not citable when only partially vectorized (not reliably in the index)', () => {
    expect(isFabFileCitable(citableFile({ vectorizedChunkCount: 2 }), { queryEmbeddingModel: QUERY_MODEL })).toBe(
      false
    );
  });

  it('is not citable when it has no chunks', () => {
    expect(
      isFabFileCitable(citableFile({ chunkCount: 0, vectorizedChunkCount: 0 }), { queryEmbeddingModel: QUERY_MODEL })
    ).toBe(false);
  });

  it('is not citable when embedded in another model space (strict, unlabeled included)', () => {
    expect(isFabFileCitable(citableFile({ embeddingModel: 'ada-002' }), { queryEmbeddingModel: QUERY_MODEL })).toBe(
      false
    );
    // Deliberately stricter than isForeignEmbeddingModel: an UNLABELED doc stays uncitable.
    expect(isFabFileCitable(citableFile({ embeddingModel: undefined }), { queryEmbeddingModel: QUERY_MODEL })).toBe(
      false
    );
  });

  it('is not citable when the query model is unresolvable (semantic arm cannot run)', () => {
    expect(isFabFileCitable(citableFile(), { queryEmbeddingModel: undefined })).toBe(false);
    expect(isFabFileCitable(citableFile(), { queryEmbeddingModel: '' })).toBe(false);
  });

  it('honors the session retrieval filter (excluded filename marker)', () => {
    expect(
      isFabFileCitable(citableFile({ fileName: 'DRAFT - spec.pdf' }), {
        queryEmbeddingModel: QUERY_MODEL,
        retrievalFilter: { excludeFilenameMarkers: ['draft'] },
      })
    ).toBe(false);
  });
});

describe('createReachableSourcesResolver', () => {
  it('returns only the citable ids from a single batched read', async () => {
    const findAllByIds = vi.fn(async (_ids: string[]) => [
      citableFile({ id: 'ok' }),
      citableFile({ id: 'deleted', deletedAt: new Date() }),
      citableFile({ id: 'stale-model', embeddingModel: 'ada-002' }),
    ]);
    const resolve = createReachableSourcesResolver({
      fabfiles: { findAllByIds } as never,
      queryEmbeddingModel: QUERY_MODEL,
    });

    const reachable = await resolve(['ok', 'deleted', 'stale-model']);

    expect(findAllByIds).toHaveBeenCalledTimes(1);
    expect([...reachable]).toEqual(['ok']);
  });

  it('short-circuits an empty id list without a DB read', async () => {
    const findAllByIds = vi.fn(async () => []);
    const resolve = createReachableSourcesResolver({ fabfiles: { findAllByIds } as never });
    expect([...(await resolve([]))]).toEqual([]);
    expect(findAllByIds).not.toHaveBeenCalled();
  });
});
