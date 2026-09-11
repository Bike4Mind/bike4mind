import { describe, expect, it, vi } from 'vitest';
import {
  createReachableSourcesResolver,
  createSourceDatesResolver,
  createSurvivingSourcesResolver,
  isFabFileCitable,
  type CitableFileFields,
} from './lakeSourceReachability';

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
    const findCitableFieldsByIds = vi.fn(async (_ids: string[]) => [
      citableFile({ id: 'ok' }),
      citableFile({ id: 'deleted', deletedAt: new Date() }),
      citableFile({ id: 'stale-model', embeddingModel: 'ada-002' }),
    ]);
    const resolve = createReachableSourcesResolver({
      fabfiles: { findCitableFieldsByIds } as never,
      queryEmbeddingModel: QUERY_MODEL,
    });

    const reachable = await resolve(['ok', 'deleted', 'stale-model']);

    expect(findCitableFieldsByIds).toHaveBeenCalledTimes(1);
    expect([...reachable]).toEqual(['ok']);
  });

  it('short-circuits an empty id list without a DB read', async () => {
    const findCitableFieldsByIds = vi.fn(async () => []);
    const resolve = createReachableSourcesResolver({ fabfiles: { findCitableFieldsByIds } as never });
    expect([...(await resolve([]))]).toEqual([]);
    expect(findCitableFieldsByIds).not.toHaveBeenCalled();
  });

  it('reads the citability PROJECTION, never the unprojected document fetch', async () => {
    // The projection is the point: a lake profile can cite one source per belief with no cap, and
    // this runs on the recall path once per chat turn. Reaching for `findAllByIds` here would drag
    // `content`/`chunks`/`vector` for the whole lake through a single invocation.
    const findAllByIds = vi.fn(async () => []);
    const findCitableFieldsByIds = vi.fn(async () => [citableFile({ id: 'ok' })]);
    const resolve = createReachableSourcesResolver({
      fabfiles: { findAllByIds, findCitableFieldsByIds } as never,
      queryEmbeddingModel: QUERY_MODEL,
    });

    await resolve(['ok']);

    expect(findCitableFieldsByIds).toHaveBeenCalledTimes(1);
    expect(findAllByIds).not.toHaveBeenCalled();
  });
});

describe('createSurvivingSourcesResolver', () => {
  it('reports existence from an id-only read, hydrating nothing', async () => {
    const findAllByIds = vi.fn(async () => []);
    const findExistingIdsByIds = vi.fn(async (_ids: string[]) => ['alive']);
    const resolve = createSurvivingSourcesResolver({
      fabfiles: { findAllByIds, findExistingIdsByIds } as never,
    });

    const surviving = await resolve(['alive', 'destroyed']);

    expect([...surviving]).toEqual(['alive']);
    expect(findExistingIdsByIds).toHaveBeenCalledWith(['alive', 'destroyed']);
    // Existence is not a reason to hydrate a document - see the repository method's own note.
    expect(findAllByIds).not.toHaveBeenCalled();
  });

  it('short-circuits an empty id list without a DB read', async () => {
    const findExistingIdsByIds = vi.fn(async () => []);
    const resolve = createSurvivingSourcesResolver({ fabfiles: { findExistingIdsByIds } as never });
    expect([...(await resolve([]))]).toEqual([]);
    expect(findExistingIdsByIds).not.toHaveBeenCalled();
  });
});

describe('createSourceDatesResolver', () => {
  it('maps each source to its document date as YYYY-MM-DD', async () => {
    // The card renders the date verbatim, so the format is the contract, not a display detail:
    // a full ISO timestamp would leak the upload MINUTE of someone else's document.
    const findCitableFieldsByIds = vi.fn(async (_ids: string[]) => [
      citableFile({ id: 'doc-1', createdAt: new Date('2026-03-14T22:31:07.000Z') }),
      citableFile({ id: 'doc-2', createdAt: new Date('2025-01-02T00:00:00.000Z') }),
    ]);
    const resolve = createSourceDatesResolver({ fabfiles: { findCitableFieldsByIds } as never });

    expect([...(await resolve(['doc-1', 'doc-2']))]).toEqual([
      ['doc-1', '2026-03-14'],
      ['doc-2', '2025-01-02'],
    ]);
  });

  it('omits a source with no date rather than inventing one', async () => {
    // A document predating the timestamp, or one the projection could not return, must come back
    // absent: recallLakeMemory renders a missing entry as "unknown", which is the honest answer.
    const findCitableFieldsByIds = vi.fn(async () => [citableFile({ id: 'doc-1', createdAt: undefined })]);
    const resolve = createSourceDatesResolver({ fabfiles: { findCitableFieldsByIds } as never });
    expect((await resolve(['doc-1', 'doc-missing'])).size).toBe(0);
  });

  it('short-circuits an empty id list without a DB read', async () => {
    const findCitableFieldsByIds = vi.fn(async () => []);
    const resolve = createSourceDatesResolver({ fabfiles: { findCitableFieldsByIds } as never });
    expect((await resolve([])).size).toBe(0);
    expect(findCitableFieldsByIds).not.toHaveBeenCalled();
  });
});
