import { describe, it, expect } from 'vitest';
import { CONVERGENCE_PAUSED_CHUNK_NOTE, CONVERGENCE_PAUSED_NOTE } from '@bike4mind/common';
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

  // This assertion was the OPPOSITE, on the premise that such a file "is served" and that the state
  // is "permanent". QA disproved both live: with zero vectors the search read path
  // (`vector: {$exists: true, $ne: []}`) returns nothing for it, and reprocess repaired one in ~9s.
  // Measured on a lake of 8 stranded / 4 healthy, the turn reported no partial flag and drew a
  // corpus-wide conclusion that every one of the missing notes contradicted. It is the DOMINANT arm
  // in practice - QA counted ~33 vectorize-arm strandings to 1 chunk-arm - so this was the hole
  // operators actually hit.
  it('withholds a kill-switch-abandoned file with zero vectors - nothing of it is retrievable', () => {
    const paused = { ...settled, vectorizedChunkCount: 0, notes: CONVERGENCE_PAUSED_NOTE };
    expect(partitionByIndexAvailability([paused]).withheld.map(f => f.id)).toEqual(['f1']);
  });

  // The carve-out that keeps the above from over-withholding: a PARTIALLY vectorized file genuinely
  // does return its embedded passages, so it ranks normally. This is why the predicate splits on the
  // vector count rather than on which marker was written.
  it('serves a partly-vectorized kill-switch-abandoned file - its embedded passages still rank', () => {
    const partly = { ...settled, chunkCount: 90, vectorizedChunkCount: 40, notes: CONVERGENCE_PAUSED_NOTE };
    expect(partitionByIndexAvailability([partly]).withheld).toEqual([]);
  });

  // The other direction, and the defect that had NO test: the marker outlives a rebuild the rescue
  // sweep performs (it enqueues without a reset), so keying on the note alone withheld a fully
  // re-chunked and re-vectorized file FOREVER, and reported the whole lake partial with it. The
  // vector count is what distinguishes repaired from stranded. commitFabFileChunks also clears the
  // marker now; this asserts the reader holds even if that clear is ever lost.
  it('serves a REPAIRED file that still carries the marker - it has vectors again', () => {
    for (const notes of [CONVERGENCE_PAUSED_NOTE, CONVERGENCE_PAUSED_CHUNK_NOTE]) {
      const repaired = { ...settled, chunkCount: 8, vectorizedChunkCount: 8, notes };
      expect(partitionByIndexAvailability([repaired]).withheld).toEqual([]);
    }
  });

  // The one chunkless file that IS withheld, and the state QA found reaching every surface as
  // "fine": a re-chunk deleted its passages and the kill switch stopped the rebuild. It is neither
  // in flight nor searchable, so without this it is silently absent while neighbours fill the top-K.
  it('withholds a file whose passages a paused re-chunk removed, though it has no chunks', () => {
    const stranded = { ...settled, chunkCount: 0, vectorizedChunkCount: 0, notes: CONVERGENCE_PAUSED_CHUNK_NOTE };
    const { servable, withheld } = partitionByIndexAvailability([stranded]);
    expect(servable).toEqual([]);
    expect(withheld.map(f => f.id)).toEqual(['f1']);
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

  // The two buckets differ on the only thing the prose tells a reader to do, so they are counted
  // apart: waiting fixes one and never fixes the other.
  it('counts a paused-rechunk file apart from the files that are merely re-indexing', () => {
    const report = buildRetrievalUnavailableReport([
      { id: 'f1', fileName: 'indexing.pdf' },
      { id: 'f2', fileName: 'stranded.pdf', notes: CONVERGENCE_PAUSED_CHUNK_NOTE },
    ]);
    expect(report.indexing.count).toBe(1);
    expect(report.paused.count).toBe(1);
    expect(report.paused.sample).toEqual([{ fileId: 'f2', fileName: 'stranded.pdf' }]);
    expect(report.partial).toBe(true);
  });

  // EITHER arm buckets as paused. Bucketing the vectorize arm as `indexing` would print "they will
  // return on their own" about a file that never will: a dropped vectorize message has no producer
  // that re-sends it, which is the one thing this prose must not get wrong.
  it('buckets a paused-VECTORIZE file as paused, not as merely re-indexing', () => {
    const report = buildRetrievalUnavailableReport([
      { id: 'f1', fileName: 'indexing.pdf' },
      { id: 'f2', fileName: 'novectors.pdf', notes: CONVERGENCE_PAUSED_NOTE },
    ]);
    expect(report.indexing.count).toBe(1);
    expect(report.paused.count).toBe(1);
    expect(report.paused.sample).toEqual([{ fileId: 'f2', fileName: 'novectors.pdf' }]);
    const prose = describeRetrievalUnavailable(report);
    expect(prose).toContain('do NOT return on');
    expect(prose).toContain('no searchable passages at all');

    // The REPAIR must lead and the admin action must be conditional. The marker outlives the pause
    // that caused it, so this text is usually read against a switch that is already back off - QA hit
    // exactly that. Naming the resume first sent the reader to a control already in the right
    // position. Asserted by position, because both clauses being merely present is what it did before.
    const rebuildAt = prose!.indexOf('Rebuild passages');
    const adminAt = prose!.indexOf('administrator');
    expect(rebuildAt).toBeGreaterThan(-1);
    expect(adminAt).toBeGreaterThan(rebuildAt);
    expect(prose).toContain('If background lake work is still paused');
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

  // The opposite remedy, and the one this sentence must not get wrong: a stranded file does NOT
  // come back on its own, so telling the reader to search again later would be false reassurance.
  it('tells the reader a paused file needs an action, not more waiting', () => {
    const text = describeRetrievalUnavailable(
      buildRetrievalUnavailableReport([{ id: 'f2', fileName: 'stranded.pdf', notes: CONVERGENCE_PAUSED_CHUNK_NOTE }])
    );
    expect(text).toContain('stranded.pdf');
    expect(text).toContain('do NOT return on');
    expect(text).not.toContain('once indexing completes');
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
