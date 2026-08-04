import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MementoTier } from '@bike4mind/common';

/**
 * Only the embedding plumbing is stubbed. computeCosineSimilarity stays REAL, because two of the
 * behaviours under test - a zero-magnitude embedding scoring NaN, and a width mismatch scoring 0 -
 * are properties of that function, and a stub would let them pass vacuously.
 */
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getProviderFromModel: () => 'openai',
    resolveEmbeddingConfig: () => ({ config: {}, missing: undefined }),
    EmbeddingFactory: class {
      createEmbeddingService() {
        return { generateEmbedding: async () => [1, 0] };
      }
    },
  };
});

import { getRelevantMementos } from './getRelevantMementos';

const PAGE_SIZE = 200;

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
};

type Row = { id: string; summary: string; embedding: number[] };

/** Zero-padded ids so lexicographic order matches insertion order, as an ObjectId string does. */
const mementoRows = (count: number, embedding: (i: number) => number[] = () => [1, 0]): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `mem-${String(i).padStart(6, '0')}`,
    summary: `fact-${i}`,
    embedding: embedding(i),
  }));

/** Real keyset arithmetic - a page-keyed stub could not observe a wrong cursor. */
const pagedMementos = (all: Row[]) =>
  vi.fn(async (_userId: string, opts: { limit?: number; afterId?: string }) =>
    all
      .filter(r => (opts.afterId ? r.id > opts.afterId : true))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, opts.limit ?? all.length)
  );

const run = (findByUserId: ReturnType<typeof pagedMementos>, topK = 5) =>
  getRelevantMementos(
    'u1',
    'what do you know about me',
    {
      topK,
      minSimilarity: 0.5,
      tier: MementoTier.HOT,
      embeddingModel: 'text-embedding-ada-002' as never,
      apiKeyTable: { openai: 'stub' },
      logger: logger as never,
    },
    {
      db: {
        mementos: { findByUserId } as never,
        apiKeys: {} as never,
        adminSettings: {} as never,
      },
    }
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getRelevantMementos pages instead of loading every memento', () => {
  it('walks past the first page and covers every memento', async () => {
    // Coverage is the whole point: there is no scan budget here, only a memory bound, so which
    // mementos get scored must be exactly what it was before paging.
    const all = mementoRows(PAGE_SIZE + 50, i => [1, i / 1000]);
    const findByUserId = pagedMementos(all);

    await run(findByUserId, 5);

    expect(findByUserId.mock.calls.length).toBeGreaterThan(1);
    const scanned = findByUserId.mock.calls.length;
    expect(scanned).toBeLessThanOrEqual(Math.ceil(all.length / PAGE_SIZE) + 1);
    for (const call of findByUserId.mock.calls) {
      expect(call[1].limit).toBe(PAGE_SIZE);
    }
  });

  it('returns the same top-K whether the corpus spans one page or several', async () => {
    // Descending similarity to [1, 0], so the best matches are the LAST rows written - i.e. only
    // reachable if the walk actually pages past the first window.
    const build = (n: number) => mementoRows(n, i => [1, (n - i) / n]);
    const many = await run(pagedMementos(build(PAGE_SIZE + 100)), 3);
    const few = await run(pagedMementos(build(PAGE_SIZE + 100).slice(-PAGE_SIZE)), 3);

    expect(many.map(m => m.similarity)).toEqual(few.map(m => m.similarity));
    expect(many).toHaveLength(3);
  });

  it('advances the cursor rather than re-reading the first page', async () => {
    const findByUserId = pagedMementos(mementoRows(PAGE_SIZE * 2 + 5));

    await run(findByUserId);

    const cursors = findByUserId.mock.calls.map(c => c[1].afterId);
    expect(cursors[0]).toBeUndefined();
    expect(new Set(cursors).size).toBe(cursors.length);
  });

  it('stops and reports rather than paging forever when the cursor does not advance', async () => {
    // A repository ignoring afterId would otherwise spin to the page cap. Retrieval fails open (memory
    // enriches an answer, it does not gate one), so the observable outcome is an empty result - which
    // makes the log the only signal, and it has to name paging rather than the embed call.
    const stuck = vi.fn(async () => mementoRows(PAGE_SIZE));

    const out = await run(stuck as never);

    expect(out).toEqual([]);
    const warned = logger.warn.mock.calls.map(c => `${c[0]} ${c[1]}`).join('\n');
    expect(warned).toContain('cursor failed to advance');
    expect(warned).not.toContain('Error generating embedding');
  });

  it('stops after one page when the user has fewer mementos than a page', async () => {
    const findByUserId = pagedMementos(mementoRows(3));

    await run(findByUserId);

    expect(findByUserId).toHaveBeenCalledTimes(1);
  });
});

describe('getRelevantMementos rejects unusable embeddings', () => {
  it('skips a memento with no embedding', async () => {
    const all = [
      { id: 'mem-000000', summary: 'no vector', embedding: [] },
      { id: 'mem-000001', summary: 'has vector', embedding: [1, 0] },
    ];

    const out = await run(pagedMementos(all));

    expect(out.map(m => m.memento.summary)).toEqual(['has vector']);
  });

  it('skips a zero-magnitude embedding rather than letting NaN outrank real matches', async () => {
    // cosine of a zero vector is NaN. NaN fails every comparison, so it slips past the similarity
    // floor and then sorts ahead of everything real.
    const all = [
      { id: 'mem-000000', summary: 'zero vector', embedding: [0, 0] },
      { id: 'mem-000001', summary: 'real match', embedding: [1, 0] },
    ];

    const out = await run(pagedMementos(all));

    expect(out.map(m => m.memento.summary)).toEqual(['real match']);
  });

  it('still applies the similarity floor', async () => {
    // Orthogonal to the query, so similarity 0 against a floor of 0.5.
    const all = [
      { id: 'mem-000000', summary: 'orthogonal', embedding: [0, 1] },
      { id: 'mem-000001', summary: 'aligned', embedding: [1, 0] },
    ];

    const out = await run(pagedMementos(all));

    expect(out.map(m => m.memento.summary)).toEqual(['aligned']);
  });

  it('returns nothing when the user has no mementos at all', async () => {
    const out = await run(pagedMementos([]));

    expect(out).toEqual([]);
  });
});

describe('getRelevantMementos keeps the document shape its consumers read', () => {
  it('returns mementos whose id is defined', async () => {
    // `memento.id` is a Mongoose virtual that a lean object does not carry, and consumers write it
    // into quest.promptMeta. A later `.lean()` for speed would silently store undefined ids.
    const out = await run(pagedMementos(mementoRows(2)));

    expect(out.length).toBeGreaterThan(0);
    for (const entry of out) {
      expect(entry.memento.id).toBeDefined();
    }
  });

  it('breaks similarity ties on id so the result does not depend on page arrival', async () => {
    // Two identical embeddings across a page boundary: without a total order the winner would be
    // whichever page arrived first.
    const all = [
      ...mementoRows(PAGE_SIZE - 1, () => [1, 0.9]),
      { id: `mem-${String(PAGE_SIZE - 1).padStart(6, '0')}`, summary: 'tie-a', embedding: [1, 0] },
      { id: `mem-${String(PAGE_SIZE).padStart(6, '0')}`, summary: 'tie-b', embedding: [1, 0] },
    ];

    const first = await run(pagedMementos(all), 1);
    const second = await run(pagedMementos(all), 1);

    expect(first[0].memento.summary).toBe(second[0].memento.summary);
    expect(first[0].memento.summary).toBe('tie-a');
  });
});
