import { describe, expect, it } from 'vitest';
import { FORCED_RETRIEVAL_MAX_SCORED_CHUNKS } from '@bike4mind/common';
import {
  applyFloors,
  buildFloorSweepRow,
  formatFloorConfig,
  formatFloorSweepTable,
  parseFloorConfigs,
  SHIPPED_CONFIG,
  ZERO_FLOOR_CONFIG,
  type FloorScorableChunk,
} from './forcedFloorSweep';

/**
 * A 2-dim unit-circle chunk at the requested cosine against the query `[1, 0]`, so every score in
 * these tests is the number written at the call site rather than something to be re-derived.
 */
const chunkAt = (cosine: number, chunkId: string, docId = chunkId, charLength = 100): FloorScorableChunk => ({
  chunkId,
  docId,
  vector: [cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine))],
  charLength,
});

const QUERY = { id: 'q01', vector: [1, 0] };

describe('parseFloorConfigs', () => {
  it('parses a sweep of relativeFloorPct:minSimilarityPct points', () => {
    expect(parseFloorConfigs('0:0,85:75,95:0')).toEqual([
      { relativeFloorPct: 0, minSimilarityPct: 0 },
      { relativeFloorPct: 85, minSimilarityPct: 75 },
      { relativeFloorPct: 95, minSimilarityPct: 0 },
    ]);
  });

  it('tolerates whitespace and trailing separators', () => {
    expect(parseFloorConfigs(' 0:0 , 90:75 ,')).toEqual([
      { relativeFloorPct: 0, minSimilarityPct: 0 },
      { relativeFloorPct: 90, minSimilarityPct: 75 },
    ]);
  });

  it('requires exactly two components, since a missing one parses as a silent 0', () => {
    // Number('') is 0 and Number.isInteger(0) is true, so "85:" would otherwise run an ungated
    // absolute floor under the name of the 75 that was asked for.
    expect(() => parseFloorConfigs('85:')).toThrow(/absolute floor/i);
    expect(() => parseFloorConfigs(':75')).toThrow(/relative floor/i);
    expect(() => parseFloorConfigs('85:75:60')).toThrow(/exactly/i);
    expect(() => parseFloorConfigs('85')).toThrow(/exactly/i);
  });

  it('rejects a floor outside 0-100, the unit both settings store', () => {
    expect(() => parseFloorConfigs('101:75')).toThrow(/relative floor/i);
    expect(() => parseFloorConfigs('85:101')).toThrow(/absolute floor/i);
    expect(() => parseFloorConfigs('-5:75')).toThrow(/relative floor/i);
    expect(() => parseFloorConfigs('85:0.75')).toThrow(/absolute floor/i);
  });

  it('rejects an empty spec and a duplicated point', () => {
    expect(() => parseFloorConfigs('')).toThrow(/no configurations/i);
    expect(() => parseFloorConfigs('85:75,85:75')).toThrow(/duplicate/i);
  });

  it('accepts the shipped defaults and the zero-floor baseline', () => {
    expect(parseFloorConfigs('0:0')).toEqual([ZERO_FLOOR_CONFIG]);
    expect(parseFloorConfigs('85:75')).toEqual([SHIPPED_CONFIG]);
  });
});

describe('formatFloorConfig', () => {
  it('labels a point with both floors named', () => {
    expect(formatFloorConfig({ relativeFloorPct: 90, minSimilarityPct: 75 })).toBe('relative=90% absolute=75%');
  });
});

describe('applyFloors', () => {
  it('admits every non-negative candidate at the zero-floor baseline', () => {
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(0.4, 'b')], ZERO_FLOOR_CONFIG);
    expect(outcome.accepted).toBe(2);
    expect(outcome.binding).toBe('none');
    expect(outcome.cutRank).toBeNull();
  });

  it('still rejects a negative cosine at a zero absolute floor, as the served path does', () => {
    // `score >= minSimilarity` with minSimilarity 0 is a real comparison, so "0" is a floor at zero
    // and not an absent floor. Getting this wrong would inflate every baseline row in the table.
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(-0.3, 'b')], ZERO_FLOOR_CONFIG);
    expect(outcome.scoredCount).toBe(2);
    expect(outcome.accepted).toBe(1);
    expect(outcome.binding).toBe('absolute');
  });

  it('cuts at a fraction of the turn top score, not at an absolute line', () => {
    // top 0.90, relative 85% -> cutoff 0.765: 0.80 survives, 0.70 does not.
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(0.8, 'b'), chunkAt(0.7, 'c')], {
      relativeFloorPct: 85,
      minSimilarityPct: 0,
    });
    expect(outcome.relativeCutoff).toBeCloseTo(0.765, 4);
    expect(outcome.accepted).toBe(2);
    expect(outcome.cutRank).toBe(3);
    expect(outcome.binding).toBe('relative');
  });

  it('is inert when the whole band sits inside the floor, which is what the sweep exists to show', () => {
    // The measured ada-002 case: band 0.8025-0.9140, weakest/top ~= 0.878, so 85% rejects nothing.
    const outcome = applyFloors(QUERY, [chunkAt(0.914, 'a'), chunkAt(0.8025, 'b')], SHIPPED_CONFIG);
    expect(outcome.accepted).toBe(2);
    expect(outcome.cutRank).toBeNull();
    expect(outcome.binding).toBe('none');
  });

  it('applies the absolute floor before the relative one, so the top score can outrank the pool', () => {
    // 0.9 clears the absolute floor; 0.5 does not, so it is gone before the relative floor is
    // computed and cannot widen the pool the relative cutoff is measured against.
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(0.5, 'b')], {
      relativeFloorPct: 85,
      minSimilarityPct: 75,
    });
    expect(outcome.topScore).toBeCloseTo(0.9, 4);
    expect(outcome.aboveAbsolute).toBe(1);
    expect(outcome.accepted).toBe(1);
    expect(outcome.binding).toBe('absolute');
  });

  it('reads topScore across every scored candidate, including ones the absolute floor rejected', () => {
    // Mirrors the served path, where topScore is updated one line before the absolute-floor
    // `continue`. Only observable when nothing clears that floor, as here.
    const outcome = applyFloors(QUERY, [chunkAt(0.6, 'a'), chunkAt(0.5, 'b')], {
      relativeFloorPct: 85,
      minSimilarityPct: 75,
    });
    expect(outcome.topScore).toBeCloseTo(0.6, 4);
    expect(outcome.accepted).toBe(0);
  });

  it('never empties a pool the absolute floor let through', () => {
    // The fraction is at most 1 and the comparison is `>=`, so the head always survives its own
    // cutoff. A floor that starved a turn with candidates in hand would be a defect, not a setting.
    for (const relativeFloorPct of [1, 50, 85, 99, 100]) {
      const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(0.8, 'b')], {
        relativeFloorPct,
        minSimilarityPct: 0,
      });
      expect(outcome.accepted).toBeGreaterThanOrEqual(1);
    }
  });

  it('drops a NaN cosine rather than letting it sort ahead of real hits', () => {
    const zeroMagnitude: FloorScorableChunk = { chunkId: 'z', docId: 'z', vector: [0, 0], charLength: 10 };
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), zeroMagnitude], ZERO_FLOOR_CONFIG);
    expect(outcome.scoredCount).toBe(1);
    expect(outcome.acceptedDocIds).toEqual(['a']);
  });

  it('leaves the -1 top-score sentinel when nothing scored', () => {
    const outcome = applyFloors(QUERY, [], SHIPPED_CONFIG);
    expect(outcome.topScore).toBe(-1);
    expect(outcome.relativeCutoff).toBe(0);
    expect(outcome.accepted).toBe(0);
  });

  it('dedupes parent documents best-first, which is the order reciprocalRank reads', () => {
    const outcome = applyFloors(
      QUERY,
      [chunkAt(0.7, 'c1', 'docA'), chunkAt(0.9, 'c2', 'docB'), chunkAt(0.8, 'c3', 'docA')],
      ZERO_FLOOR_CONFIG
    );
    expect(outcome.acceptedDocIds).toEqual(['docB', 'docA']);
  });

  it('reports the rank the char budget binds at, so a later cut rank reads as dormant', () => {
    const outcome = applyFloors(
      QUERY,
      [chunkAt(0.9, 'a', 'a', 60), chunkAt(0.85, 'b', 'b', 60), chunkAt(0.8, 'c', 'c', 60)],
      ZERO_FLOOR_CONFIG,
      100
    );
    expect(outcome.charsAdmitted).toBe(100);
    expect(outcome.budgetStopRank).toBe(2);
  });

  it('leaves budgetStopRank null when the accepted set fits inside the budget', () => {
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a', 'a', 10)], ZERO_FLOOR_CONFIG, 10_000);
    expect(outcome.budgetStopRank).toBeNull();
    expect(outcome.charsAdmitted).toBe(10);
  });
});

describe('buildFloorSweepRow', () => {
  // 0.76 sits in the narrow window where BOTH floors bite: above the 75% absolute line, below 85%
  // of the 0.90 top score. That window is the whole subject of the sweep - it is where a relative
  // floor stops being a no-op over an absolute one.
  const chunks = [chunkAt(0.9, 'a', 'docA'), chunkAt(0.76, 'b', 'docB'), chunkAt(0.6, 'c', 'docC')];
  const queries = [{ id: 'q01', vector: [1, 0], supporting: ['docA'] }];

  it('reports the relative floor as unbound when it cuts nothing', () => {
    const row = buildFloorSweepRow({ config: ZERO_FLOOR_CONFIG, chunks, queries });
    expect(row.relativeBoundShare).toBe(0);
    expect(row.meanCutRank).toBeNull();
    expect(row.meanAccepted).toBe(3);
  });

  it('separates the relative floor cost from the absolute floor cost', () => {
    // absolute 75% removes 0.60; relative 85% of 0.90 = 0.765 then removes 0.76.
    const row = buildFloorSweepRow({ config: { relativeFloorPct: 85, minSimilarityPct: 75 }, chunks, queries });
    expect(row.meanAboveAbsolute).toBe(2);
    expect(row.meanAccepted).toBe(1);
    expect(row.relativeBoundShare).toBe(1);
    expect(row.meanCutRank).toBe(2);
  });

  it('blames the pool cap on the cap, not on the absolute floor', () => {
    // Every candidate clears the absolute floor, so the only thing removing any of them is
    // FORCED_RETRIEVAL_MAX_SCORED_CHUNKS. Attributing that to a floor would name the wrong gate and
    // read as a floor doing work it never did.
    const many = Array.from({ length: FORCED_RETRIEVAL_MAX_SCORED_CHUNKS + 4 }, (_, i) =>
      chunkAt(0.9, `c${String(i).padStart(4, '0')}`)
    );
    const row = buildFloorSweepRow({ config: { relativeFloorPct: 0, minSimilarityPct: 75 }, chunks: many, queries });
    expect(row.cappedQueries).toBe(1);
    expect(row.meanAboveAbsolute).toBe(FORCED_RETRIEVAL_MAX_SCORED_CHUNKS);
    expect(row.relativeBoundShare).toBe(0);
  });

  it('counts a query the floors emptied, which only the absolute floor can do', () => {
    const row = buildFloorSweepRow({
      config: { relativeFloorPct: 85, minSimilarityPct: 95 },
      chunks,
      queries,
    });
    expect(row.emptiedQueries).toBe(1);
  });

  it('scores the accepted set against the committed ground truth', () => {
    const row = buildFloorSweepRow({ config: ZERO_FLOOR_CONFIG, chunks, queries });
    expect(row.quality.recall).toBe(1);
    expect(row.queries).toBe(1);
  });

  it('holds up with no queries rather than dividing by zero', () => {
    const row = buildFloorSweepRow({ config: SHIPPED_CONFIG, chunks, queries: [] });
    expect(row.queries).toBe(0);
    expect(row.relativeBoundShare).toBe(0);
    expect(row.budgetBoundShare).toBe(0);
    expect(row.meanCutRank).toBeNull();
  });
});

describe('formatFloorSweepTable', () => {
  const chunks = [chunkAt(0.9, 'a', 'docA'), chunkAt(0.8, 'b', 'docB')];
  const queries = [{ id: 'q01', vector: [1, 0], supporting: ['docA'] }];
  const row = (config: { relativeFloorPct: number; minSimilarityPct: number }) =>
    buildFloorSweepRow({ config, chunks, queries });

  it('renders one row per floor pair under a Markdown header', () => {
    const lines = formatFloorSweepTable([row(ZERO_FLOOR_CONFIG), row(SHIPPED_CONFIG)]).split('\n');
    expect(lines).toHaveLength(4); // header + separator + 2 rows
    expect(lines[0]).toContain('budget-bound');
  });

  it('prints the relative floor as "off" at 0, but never the absolute one', () => {
    // A 0 relative floor skips the filter entirely. A 0 ABSOLUTE floor is a real line - it rejects
    // negative cosines - so labelling it "off" would claim the baseline row is the whole scored
    // pool when it is not.
    expect(formatFloorSweepTable([row(ZERO_FLOOR_CONFIG)]).split('\n')[2]).toContain('| off | 0% |');
  });

  it('prints "never" rather than a rank when the floor cuts nothing', () => {
    // A 0 here would read as "cuts at rank 0", i.e. rejects everything - the opposite of inert.
    expect(formatFloorSweepTable([row(ZERO_FLOOR_CONFIG)]).split('\n')[2]).toContain('never');
  });

  it('shows both floors with their units', () => {
    expect(formatFloorSweepTable([row({ relativeFloorPct: 90, minSimilarityPct: 75 })]).split('\n')[2]).toContain(
      '| 90% | 75% |'
    );
  });

  it('renders a header even with no rows, so an empty run is visibly empty', () => {
    expect(formatFloorSweepTable([]).split('\n')).toHaveLength(2);
  });
});
