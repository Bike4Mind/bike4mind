import { describe, expect, it } from 'vitest';
import {
  buildArmRow,
  formatArmSummary,
  formatComparisonTable,
  scoreBand,
  scoreQueryDistribution,
  type ScorableChunk,
} from './scoreDistribution';

/**
 * Hand-computable 2-D unit vectors: cosine against [1,0] is just the x component, so every number
 * below is checkable by eye rather than by re-running the implementation.
 */
const QUERY = [1, 0];
const AT = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

const chunk = (chunkId: string, docId: string, vector: number[]): ScorableChunk => ({ chunkId, docId, vector });

describe('scoreQueryDistribution', () => {
  const chunks = [
    chunk('c1', 'docA', AT(0)), // cos = 1.0
    chunk('c2', 'docB', AT(60)), // cos = 0.5
    chunk('c3', 'docC', AT(90)), // cos = 0.0
  ];

  it('ranks by cosine, best first, and reports the rank-1 to rank-N spread', () => {
    const d = scoreQueryDistribution('q1', QUERY, chunks, 3);
    expect(d.topScores.map(s => +s.toFixed(4))).toEqual([1, 0.5, 0]);
    expect(d.spread).toBeCloseTo(1, 6);
    expect(d.servedDocIds).toEqual(['docA', 'docB', 'docC']);
  });

  it('measures the spread over the depth actually inspected, not the whole corpus', () => {
    // The collapse this harness looks for is a property of the TOP of the ranking. Widening the
    // depth to include the far tail would manufacture a spread no reader ever sees.
    expect(scoreQueryDistribution('q1', QUERY, chunks, 2).spread).toBeCloseTo(0.5, 6);
  });

  it('scores a collapsed band as a near-zero spread', () => {
    // The prod symptom: ten results the retriever cannot tell apart.
    const flat = [chunk('c1', 'docA', AT(40)), chunk('c2', 'docB', AT(41)), chunk('c3', 'docC', AT(42))];
    const d = scoreQueryDistribution('q1', QUERY, flat, 3);
    expect(d.spread).toBeLessThan(0.03);
  });

  it('dedupes documents forward, keeping the best-scoring chunk of a document first', () => {
    const d = scoreQueryDistribution(
      'q1',
      QUERY,
      [chunk('c1', 'docA', AT(80)), chunk('c2', 'docB', AT(10)), chunk('c3', 'docA', AT(0))],
      3
    );
    expect(d.servedDocIds).toEqual(['docA', 'docB']);
  });

  it('breaks score ties on chunkId so the ranking cannot depend on arrival order', () => {
    const tied = [chunk('cB', 'docB', AT(30)), chunk('cA', 'docA', AT(30))];
    expect(scoreQueryDistribution('q1', QUERY, tied, 2).servedDocIds).toEqual(['docA', 'docB']);
    expect(scoreQueryDistribution('q1', QUERY, [...tied].reverse(), 2).servedDocIds).toEqual(['docA', 'docB']);
  });

  it('reports a zero spread when a single chunk was served', () => {
    expect(scoreQueryDistribution('q1', QUERY, [chunk('c1', 'docA', AT(0))], 3).spread).toBe(0);
  });
});

describe('scoreBand', () => {
  it('pools every served score across queries rather than averaging per-query bands', () => {
    // Each query looks spread on its own (0.1 wide) while the corpus sits in one 0.2-wide slice.
    // Averaging per-query bands would report 0.1 and hide exactly the collapse being measured.
    const band = scoreBand([
      { queryId: 'q1', topScores: [0.88, 0.78], spread: 0.1, servedDocIds: [] },
      { queryId: 'q2', topScores: [0.78, 0.68], spread: 0.1, servedDocIds: [] },
    ]);
    expect(band.min).toBeCloseTo(0.68, 6);
    expect(band.max).toBeCloseTo(0.88, 6);
    expect(band.width).toBeCloseTo(0.2, 6);
  });

  it('is zero-width when nothing was served', () => {
    expect(scoreBand([])).toEqual({ min: 0, max: 0, width: 0 });
  });
});

describe('buildArmRow', () => {
  const chunks = [chunk('c1', 'docA', AT(0)), chunk('c2', 'docB', AT(60)), chunk('c3', 'docC', AT(90))];

  it('carries the geometry and the retrieval quality in one row', () => {
    const row = buildArmRow({
      arm: 'text-embedding-3-small@1536',
      chunks,
      filesInScope: 2,
      chunksExcluded: 4,
      filesExcluded: 1,
      queries: [{ id: 'q1', vector: QUERY, supporting: ['docA'] }],
      depth: 3,
    });

    expect(row.arm).toBe('text-embedding-3-small@1536');
    expect(row.filesInScope).toBe(2);
    expect(row.chunksScored).toBe(3);
    expect(row.chunksExcluded).toBe(4);
    expect(row.filesExcluded).toBe(1);
    expect(row.spreads).toHaveLength(1);
    expect(row.queries).toBe(1);
    expect(row.band.width).toBeCloseTo(1, 6);
    expect(row.meanTopScore).toBeCloseTo(1, 6);
    expect(row.positiveTopScore).toBeCloseTo(1, 6);
    expect(row.negativeTopScore).toBe(0); // no negative questions in this arm
    expect(row.meanSpread).toBeCloseTo(1, 6);
    // docA ranked first out of three documents served.
    expect(row.quality.recall).toBe(1);
    expect(row.quality.mrr).toBe(1);
    expect(row.quality.precision).toBeCloseTo(1 / 3, 6);
  });

  it('scores a negative question through falsePositiveRate, not recall', () => {
    const row = buildArmRow({
      arm: 'arm',
      chunks,
      filesInScope: 3,
      chunksExcluded: 0,
      filesExcluded: 0,
      queries: [{ id: 'q1', vector: QUERY, supporting: [] }],
      depth: 3,
    });
    expect(row.quality.negatives).toBe(1);
    expect(row.quality.falsePositiveRate).toBe(1);
    // The number that CAN move: how high an unanswerable question scores. A floor separates
    // answerable from unanswerable only if this sits measurably below positiveTopScore.
    expect(row.negativeTopScore).toBeCloseTo(1, 6);
    expect(row.positiveTopScore).toBe(0);
  });
});

describe('formatComparisonTable', () => {
  it('renders one row per arm under a shared header, so arms read down a column', () => {
    const rows = ['a@1536', 'b@3072'].map(arm =>
      buildArmRow({
        arm,
        chunks: [chunk('c1', 'docA', AT(0)), chunk('c2', 'docB', AT(60))],
        filesInScope: 2,
        chunksExcluded: 0,
        filesExcluded: 0,
        queries: [{ id: 'q1', vector: QUERY, supporting: ['docA'] }],
        depth: 2,
      })
    );
    const table = formatComparisonTable(rows);
    const lines = table.split('\n');

    expect(lines).toHaveLength(4); // header, rule, two arms
    expect(lines[0]).toContain('band min');
    expect(lines[0]).toContain('width');
    expect(lines[0]).toContain('mrr');
    expect(lines[0]).toContain('posTop');
    expect(lines[0]).toContain('negTop');
    // falsePositiveRate is structurally 1.0 offline (no floor is applied), so it is not a column.
    expect(lines[0]).not.toContain('fpr');
    expect(lines[2]).toContain('a@1536');
    expect(lines[3]).toContain('b@3072');
    // Fixed-width, so the same column starts at the same offset on every row.
    expect(new Set(lines.map(l => l.length)).size).toBe(1);
  });
});

describe('formatArmSummary', () => {
  const row = buildArmRow({
    arm: 'text-embedding-ada-002@1536',
    chunks: [chunk('c1', 'docA', AT(0)), chunk('c2', 'docB', AT(60))],
    filesInScope: 49,
    chunksExcluded: 0,
    filesExcluded: 0,
    queries: [{ id: 'q1', vector: QUERY, supporting: ['docA'] }],
    depth: 2,
  });

  it('prints the same labelled block the prod probe published, so the two can be read side by side', () => {
    const summary = formatArmSummary(row);
    expect(summary).toContain('files_in_scope       : 49');
    expect(summary).toContain('chunks_scored        : 2');
    expect(summary).toContain('embedding_mismatch   : 0 excluded files, 0 skipped chunks');
    expect(summary).toContain('overall band         : ');
    expect(summary).toContain('r1-r10 spread        : ');
  });

  it('reports the counters this instrument cannot observe as n/a, never as zero', () => {
    // Offline exact kNN has no indexing state and runs no collapse pass. Printing 0 would claim the
    // harness looked and found none - a different, and untrue, statement than "cannot arise here".
    const summary = formatArmSummary(row);
    expect(summary).toContain('retrieval_unavailable: n/a');
    expect(summary).toContain('superseded           : n/a');
  });

  it('elides the per-query spreads once a real 31-question run would overflow the line', () => {
    const many = { ...row, spreads: Array.from({ length: 31 }, (_, i) => i / 1000) };
    expect(formatArmSummary(many)).toContain('... (31 queries)');
    expect(formatArmSummary(row)).not.toContain('...');
  });
});
