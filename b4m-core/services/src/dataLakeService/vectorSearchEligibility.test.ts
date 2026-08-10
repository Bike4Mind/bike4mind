import { describe, expect, it } from 'vitest';
import {
  isVectorSearchReady,
  partitionByVectorSearchReadiness,
  VECTOR_SEARCH_READY_LAG_MS,
} from './vectorSearchEligibility';

const NOW = new Date('2026-08-06T12:00:00.000Z');

describe('isVectorSearchReady', () => {
  it('is false when never stamped', () => {
    expect(isVectorSearchReady({ id: 'f1' }, NOW)).toBe(false);
  });

  it('is false for a stamp fresher than the mongot lag window', () => {
    const fresh = new Date(NOW.getTime() - 1_000);
    expect(isVectorSearchReady({ id: 'f1', chunkEmbeddingModelStampedAt: fresh }, NOW)).toBe(false);
  });

  it('is true for a stamp exactly at the lag boundary', () => {
    const boundary = new Date(NOW.getTime() - VECTOR_SEARCH_READY_LAG_MS);
    expect(isVectorSearchReady({ id: 'f1', chunkEmbeddingModelStampedAt: boundary }, NOW)).toBe(true);
  });

  it('is true for a stamp well past the lag window', () => {
    const old = new Date(NOW.getTime() - 10 * VECTOR_SEARCH_READY_LAG_MS);
    expect(isVectorSearchReady({ id: 'f1', chunkEmbeddingModelStampedAt: old }, NOW)).toBe(true);
  });

  it('is false for an unparsable stamp rather than throwing', () => {
    expect(isVectorSearchReady({ id: 'f1', chunkEmbeddingModelStampedAt: 'not-a-date' }, NOW)).toBe(false);
  });

  it('accepts a stamp serialized as a string (as it arrives over JSON)', () => {
    const old = new Date(NOW.getTime() - 10 * VECTOR_SEARCH_READY_LAG_MS).toISOString();
    expect(isVectorSearchReady({ id: 'f1', chunkEmbeddingModelStampedAt: old }, NOW)).toBe(true);
  });
});

describe('partitionByVectorSearchReadiness', () => {
  it('splits ready and not-ready files without dropping or reordering within each group', () => {
    const old = new Date(NOW.getTime() - 10 * VECTOR_SEARCH_READY_LAG_MS);
    const fresh = new Date(NOW.getTime() - 1_000);
    const files = [
      { id: 'a', chunkEmbeddingModelStampedAt: old },
      { id: 'b', chunkEmbeddingModelStampedAt: fresh },
      { id: 'c', chunkEmbeddingModelStampedAt: old },
      { id: 'd' },
    ];
    const { annReady, scanOnly } = partitionByVectorSearchReadiness(files, NOW);
    expect(annReady.map(f => f.id)).toEqual(['a', 'c']);
    expect(scanOnly.map(f => f.id)).toEqual(['b', 'd']);
  });

  it('returns empty groups for an empty input', () => {
    expect(partitionByVectorSearchReadiness([], NOW)).toEqual({ annReady: [], scanOnly: [] });
  });
});
