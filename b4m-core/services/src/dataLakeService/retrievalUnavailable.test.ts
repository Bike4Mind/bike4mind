import { describe, it, expect } from 'vitest';
import { CONVERGENCE_PAUSED_NOTE } from '@bike4mind/common';
import {
  buildRetrievalUnavailableReport,
  describeRetrievalUnavailable,
  describeSearchLimitations,
  emptyRetrievalUnavailableReport,
  isPartialSearch,
  partitionByIndexAvailability,
} from './retrievalUnavailable';
import { emptyEmbeddingMismatchReport } from './embeddingMismatch';

/** A settled, fully-embedded file - every case below perturbs one field. */
const settled = { id: 'f1', fileName: 'a.pdf', chunkCount: 8, vectorizedChunkCount: 8, error: null, notes: null };

describe('partitionByIndexAvailability (#1681 constraint 1)', () => {
  it('serves a fully-indexed file', () => {
    expect(partitionByIndexAvailability([settled]).withheld).toEqual([]);
  });

  // The state a convergence rewrite leaves behind: chunks exist, none carry a vector yet, and the
  // OLD vectors are already deleted. The file can only contribute nothing.
  it('withholds a file whose chunks are reinserted but not yet embedded', () => {
    const { servable, withheld } = partitionByIndexAvailability([{ ...settled, vectorizedChunkCount: 0 }]);
    expect(servable).toEqual([]);
    expect(withheld.map(f => f.id)).toEqual(['f1']);
  });

  it('withholds a partly-embedded file, not just a zero one', () => {
    expect(partitionByIndexAvailability([{ ...settled, vectorizedChunkCount: 3 }]).withheld).toHaveLength(1);
  });

  // A permanently broken file never reaches the terminal count. Withholding it would mark EVERY
  // search partial forever with no remedy - the flag-that-cries-wolf failure the epic names.
  it('serves a terminally failed file rather than withholding it forever', () => {
    expect(partitionByIndexAvailability([{ ...settled, vectorizedChunkCount: 0, error: 'boom' }]).withheld).toEqual([]);
  });

  // Same reasoning, reached by the other route: the kill switch abandons a vectorize via `notes`
  // and never sets `error`, and its own log states these do not auto-resume.
  it('serves a kill-switch-abandoned file rather than withholding it forever', () => {
    const paused = { ...settled, vectorizedChunkCount: 0, notes: CONVERGENCE_PAUSED_NOTE };
    expect(partitionByIndexAvailability([paused]).withheld).toEqual([]);
  });

  it('serves a chunkless file (an image, a still-uploading row) rather than flagging every lake', () => {
    expect(partitionByIndexAvailability([{ ...settled, chunkCount: 0, vectorizedChunkCount: 0 }]).withheld).toEqual([]);
    expect(partitionByIndexAvailability([{ id: 'x' }]).withheld).toEqual([]);
  });

  // A legacy file predating vectorizedChunkCount must keep being served, not silently disappear.
  it('serves a file whose vector rollup predates the field', () => {
    expect(partitionByIndexAvailability([{ ...settled, vectorizedChunkCount: null }]).withheld).toEqual([]);
  });
});

describe('buildRetrievalUnavailableReport', () => {
  it('is not partial when nothing was withheld', () => {
    expect(buildRetrievalUnavailableReport([])).toEqual(emptyRetrievalUnavailableReport());
  });

  it('caps the sample but keeps the count exact', () => {
    const withheld = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, fileName: `f${i}.pdf` }));
    const report = buildRetrievalUnavailableReport(withheld);
    expect(report.indexing.count).toBe(9);
    expect(report.indexing.sample).toHaveLength(5);
    expect(report.partial).toBe(true);
  });
});

describe('describeRetrievalUnavailable', () => {
  it('says nothing when the search was complete', () => {
    expect(describeRetrievalUnavailable(emptyRetrievalUnavailableReport())).toBeNull();
    expect(describeRetrievalUnavailable(undefined)).toBeNull();
  });

  // The remedy is TIME. Sending the reader to re-embed a file that is already re-embedding is the
  // one wrong thing this sentence could do.
  it('names the files and points at waiting, never at re-embedding', () => {
    const text = describeRetrievalUnavailable(buildRetrievalUnavailableReport([{ id: 'f1', fileName: 'a.pdf' }]));
    expect(text).toContain('a.pdf');
    expect(text).toContain('once indexing completes');
    expect(text).not.toMatch(/re-embed those/i);
  });

  it('marks the sample as truncated when more files were withheld than named', () => {
    const withheld = Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, fileName: `f${i}.pdf` }));
    expect(describeRetrievalUnavailable(buildRetrievalUnavailableReport(withheld))).toContain(', ...');
  });
});

describe('describeSearchLimitations / isPartialSearch', () => {
  const search = (over: Record<string, unknown>) => ({
    embeddingMismatch: emptyEmbeddingMismatchReport(),
    retrievalUnavailable: emptyRetrievalUnavailableReport(),
    embeddingModel: 'text-embedding-3-small',
    ...over,
  });

  it('says nothing for a complete search', () => {
    expect(describeSearchLimitations(search({}))).toBeNull();
    expect(isPartialSearch(search({}))).toBe(false);
  });

  it('reports an unavailable-content search as partial', () => {
    const s = search({ retrievalUnavailable: buildRetrievalUnavailableReport([{ id: 'f1' }]) });
    expect(isPartialSearch(s)).toBe(true);
    expect(describeSearchLimitations(s)).toContain('being re-indexed');
  });

  it('reports both reasons in one notice when both apply', () => {
    const mismatch = {
      ...emptyEmbeddingMismatchReport(),
      partial: true,
      excludedFiles: { count: 2, models: ['ada-002'], estimatedChunks: 10, sample: [] },
    };
    const text = describeSearchLimitations(
      search({ embeddingMismatch: mismatch, retrievalUnavailable: buildRetrievalUnavailableReport([{ id: 'f1' }]) })
    );
    expect(text).toContain('ada-002');
    expect(text).toContain('being re-indexed');
  });
});
