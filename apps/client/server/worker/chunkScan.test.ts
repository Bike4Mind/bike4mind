import { describe, expect, it } from 'vitest';
import { buildFabFileChunkScanFilter } from './chunkScan';

// Minimal evaluator for the subset of Mongo operators the scan filter uses, so we can assert
// which documents the filter would (not) select without a live Mongo.
type Doc = Record<string, unknown>;
const matches = (doc: Doc, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond === null) return value === null || value === undefined;
    if (cond && typeof cond === 'object' && '$ne' in cond) return value !== (cond as { $ne: unknown }).$ne;
    if (cond && typeof cond === 'object' && '$lt' in cond) return (value as Date) < (cond as { $lt: Date }).$lt;
    return value === cond;
  });

describe('buildFabFileChunkScanFilter', () => {
  const cutoff = new Date('2026-01-01T00:00:00Z');
  const old = new Date('2025-12-31T00:00:00Z'); // before cutoff
  const filter = buildFabFileChunkScanFilter(cutoff);

  it("requires status 'complete' so a never-completed upload is skipped", () => {
    expect(filter.status).toBe('complete');
  });

  it('selects a completed, un-chunked, old, not-in-progress file', () => {
    const doc = { status: 'complete', chunkCount: 0, isChunking: false, createdAt: old, deletedAt: null };
    expect(matches(doc, filter)).toBe(true);
  });

  it('skips a file whose upload never completed (stuck pending)', () => {
    // The failed-upload case: the record exists but no object ever landed in storage.
    const doc = { status: 'pending', chunkCount: 0, isChunking: false, createdAt: old, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips a file that is actively chunking', () => {
    const doc = { status: 'complete', chunkCount: 0, isChunking: true, createdAt: old, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips an already-chunked file', () => {
    const doc = { status: 'complete', chunkCount: 5, isChunking: false, createdAt: old, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips a just-uploaded file still within the age window', () => {
    const recent = new Date('2026-01-01T00:01:00Z'); // after cutoff
    const doc = { status: 'complete', chunkCount: 0, isChunking: false, createdAt: recent, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });
});
