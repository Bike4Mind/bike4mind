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

/**
 * A mass of off-topic chunks, so the median score is a background and not one of the hits. Every
 * spread-floor case needs one: that gate reads the turn's own distribution, and a pool where the
 * relevant chunks are a large fraction of the whole is not the distribution a real scan produces.
 */
const BACKGROUND: FloorScorableChunk[] = Array.from({ length: 15 }, (_, i) =>
  chunkAt(0.2 + i * 0.01, `bg${String(i).padStart(2, '0')}`)
);

describe('parseFloorConfigs', () => {
  it('parses a sweep of relativeFloorPct:minSimilarityPct points', () => {
    expect(parseFloorConfigs('0:0,85:75,95:0')).toEqual([
      { relativeFloorPct: 0, minSimilarityPct: 0, spreadFloorPct: 0 },
      { relativeFloorPct: 85, minSimilarityPct: 75, spreadFloorPct: 0 },
      { relativeFloorPct: 95, minSimilarityPct: 0, spreadFloorPct: 0 },
    ]);
  });

  it('reads an optional third component as the spread floor', () => {
    expect(parseFloorConfigs('85:75:40,0:35:60')).toEqual([
      { relativeFloorPct: 85, minSimilarityPct: 75, spreadFloorPct: 40 },
      { relativeFloorPct: 0, minSimilarityPct: 35, spreadFloorPct: 60 },
    ]);
  });

  it('defaults an omitted spread floor to 0, so a pre-existing --floors string measures what it did', () => {
    expect(parseFloorConfigs('85:75')).toEqual([{ relativeFloorPct: 85, minSimilarityPct: 75, spreadFloorPct: 0 }]);
  });

  it('tolerates whitespace and trailing separators', () => {
    expect(parseFloorConfigs(' 0:0 , 90:75 ,')).toEqual([
      { relativeFloorPct: 0, minSimilarityPct: 0, spreadFloorPct: 0 },
      { relativeFloorPct: 90, minSimilarityPct: 75, spreadFloorPct: 0 },
    ]);
  });

  it('requires two or three components, since a written-but-blank one parses as a silent 0', () => {
    // Number('') is 0 and Number.isInteger(0) is true, so "85:" would otherwise run an ungated
    // absolute floor under the name of the 75 that was asked for. An ABSENT third component is a
    // different case and legitimately means 0 - see the default test above.
    expect(() => parseFloorConfigs('85:')).toThrow(/absolute floor/i);
    expect(() => parseFloorConfigs(':75')).toThrow(/relative floor/i);
    expect(() => parseFloorConfigs('85:75:')).toThrow(/spread floor/i);
    expect(() => parseFloorConfigs('85:75:60:5')).toThrow(/expected/i);
    expect(() => parseFloorConfigs('85')).toThrow(/expected/i);
  });

  it('rejects a floor outside 0-100, the unit all three settings store', () => {
    expect(() => parseFloorConfigs('101:75')).toThrow(/relative floor/i);
    expect(() => parseFloorConfigs('85:101')).toThrow(/absolute floor/i);
    expect(() => parseFloorConfigs('-5:75')).toThrow(/relative floor/i);
    expect(() => parseFloorConfigs('85:0.75')).toThrow(/absolute floor/i);
    expect(() => parseFloorConfigs('85:75:101')).toThrow(/spread floor/i);
    expect(() => parseFloorConfigs('85:75:-1')).toThrow(/spread floor/i);
  });

  it('rejects an empty spec and a duplicated point', () => {
    expect(() => parseFloorConfigs('')).toThrow(/no configurations/i);
    expect(() => parseFloorConfigs('85:75,85:75')).toThrow(/duplicate/i);
    // The dedupe key names all three floors, so these are two distinct points and not a duplicate.
    expect(() => parseFloorConfigs('85:75,85:75:40')).not.toThrow();
  });

  it('accepts the shipped defaults and the zero-floor baseline', () => {
    expect(parseFloorConfigs('0:0')).toEqual([ZERO_FLOOR_CONFIG]);
    expect(parseFloorConfigs('85:75')).toEqual([SHIPPED_CONFIG]);
  });
});

describe('formatFloorConfig', () => {
  it('labels a point with all three floors named', () => {
    expect(formatFloorConfig({ relativeFloorPct: 90, minSimilarityPct: 75, spreadFloorPct: 40 })).toBe(
      'relative=90% absolute=75% spread=40%'
    );
  });

  it('prints an absent spread floor as 0 rather than omitting it, so two points cannot collide', () => {
    expect(formatFloorConfig({ relativeFloorPct: 90, minSimilarityPct: 75 })).toBe(
      'relative=90% absolute=75% spread=0%'
    );
  });
});

describe('applyFloors', () => {
  it('admits every non-negative candidate at the zero-floor baseline', () => {
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(0.4, 'b')], ZERO_FLOOR_CONFIG);
    expect(outcome.accepted).toBe(2);
    expect(outcome.binding).toEqual([]);
    expect(outcome.cutRank).toBeNull();
  });

  it('still rejects a negative cosine at a zero absolute floor, as the served path does', () => {
    // `score >= minSimilarity` with minSimilarity 0 is a real comparison, so "0" is a floor at zero
    // and not an absent floor. Getting this wrong would inflate every baseline row in the table.
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(-0.3, 'b')], ZERO_FLOOR_CONFIG);
    expect(outcome.scoredCount).toBe(2);
    expect(outcome.accepted).toBe(1);
    expect(outcome.binding).toEqual(['absolute']);
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
    expect(outcome.binding).toEqual(['relative']);
  });

  it('is inert when the whole band sits inside the floor, which is what the sweep exists to show', () => {
    // The measured ada-002 case: band 0.8025-0.9140, weakest/top ~= 0.878, so 85% rejects nothing.
    const outcome = applyFloors(QUERY, [chunkAt(0.914, 'a'), chunkAt(0.8025, 'b')], SHIPPED_CONFIG);
    expect(outcome.accepted).toBe(2);
    expect(outcome.cutRank).toBeNull();
    expect(outcome.binding).toEqual([]);
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
    expect(outcome.binding).toEqual(['absolute']);
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

  it('cuts on the spread floor where the relative floor is inert, which is the point of the gate', () => {
    // The measured ada-002 shape, and the reason no background mass appears here: on that corpus
    // the whole band sat at 0.8025-0.9140, so there IS no low tail for a median to fall into. Every
    // score is within 15% of the top, putting 85% of top (0.777) below all of it. The top-to-median
    // span is 0.005, and cutting 40% of the way down it lands at 0.912 - which still separates the
    // two leaders from the rest, on a distribution where a fraction-of-top floor cannot.
    const collapsed = [chunkAt(0.914, 'a'), chunkAt(0.912, 'b'), chunkAt(0.906, 'c'), chunkAt(0.904, 'd')];
    const withoutSpread = applyFloors(QUERY, collapsed, { relativeFloorPct: 85, minSimilarityPct: 0 });
    expect(withoutSpread.accepted).toBe(4);
    expect(withoutSpread.binding).toEqual([]);

    const withSpread = applyFloors(QUERY, collapsed, {
      relativeFloorPct: 85,
      minSimilarityPct: 0,
      spreadFloorPct: 40,
    });
    expect(withSpread.backgroundScore).toBeCloseTo(0.909, 4);
    expect(withSpread.spreadCutoff).toBeCloseTo(0.912, 4);
    expect(withSpread.accepted).toBe(2);
    expect(withSpread.spreadCutRank).toBe(3);
    expect(withSpread.binding).toEqual(['spread']);
  });

  it('admits more on a diffuse question than a sharp one at the same floor, which no fixed line does', () => {
    // Same floor, same corpus size, same top score, same background mass. The only difference is
    // the SHAPE near the top: one question has a single standout, the other has four near-equals.
    // A fraction-of-top floor cannot tell those apart, and a fixed cosine line certainly cannot.
    //
    // The background mass is what makes this realistic rather than a toy. A scan reaches thousands
    // of chunks of which a handful are relevant, so the median sits deep in the irrelevant tail.
    // Over a pool small enough that the relevant chunks ARE half of it, the median lands inside the
    // relevant cluster and the gate reads the corpus, not the question - see the pool-cap caveat in
    // MODEL-COMPARISON.md for the same distinction in the live measurement.
    const config = { relativeFloorPct: 0, minSimilarityPct: 0, spreadFloorPct: 50 };
    const sharp = applyFloors(QUERY, [chunkAt(0.9, 'top'), ...BACKGROUND], config);
    const diffuse = applyFloors(
      QUERY,
      [chunkAt(0.9, 'n1'), chunkAt(0.88, 'n2'), chunkAt(0.86, 'n3'), chunkAt(0.84, 'n4'), ...BACKGROUND],
      config
    );
    expect(sharp.accepted).toBe(1);
    expect(diffuse.accepted).toBe(4);
  });

  it('never empties a pool, at any spread floor, because the cutoff cannot exceed the top score', () => {
    for (const spreadFloorPct of [1, 25, 50, 85, 99, 100]) {
      const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(0.1, 'b')], {
        relativeFloorPct: 0,
        minSimilarityPct: 0,
        spreadFloorPct,
      });
      expect(outcome.accepted).toBeGreaterThanOrEqual(1);
    }
  });

  it('reads the background over every scored chunk, not over the pool the absolute floor left', () => {
    // If the background were read off the surviving pool it would move with the absolute floor -
    // making the spread floor a function of the very gate it exists to be independent of.
    const chunks = [chunkAt(0.9, 'a'), chunkAt(0.8, 'b'), chunkAt(0.2, 'c'), chunkAt(0.1, 'd')];
    const ungated = applyFloors(QUERY, chunks, { relativeFloorPct: 0, minSimilarityPct: 0, spreadFloorPct: 50 });
    const gated = applyFloors(QUERY, chunks, { relativeFloorPct: 0, minSimilarityPct: 75, spreadFloorPct: 50 });
    // Median of all four scores either way: (0.8 + 0.2) / 2.
    expect(ungated.backgroundScore).toBeCloseTo(0.5, 4);
    expect(gated.backgroundScore).toBeCloseTo(0.5, 4);
    expect(gated.spreadCutoff).toBeCloseTo(ungated.spreadCutoff, 4);
  });

  it('does not cut when every score is identical, since a zero span measures no signal', () => {
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(0.9, 'b'), chunkAt(0.9, 'c')], {
      relativeFloorPct: 0,
      minSimilarityPct: 0,
      spreadFloorPct: 10,
    });
    expect(outcome.spreadCutoff).toBe(0);
    expect(outcome.accepted).toBe(3);
    expect(outcome.spreadCutRank).toBeNull();
  });

  it('leaves the spread floor off at 0, rather than cutting at the top score', () => {
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(0.1, 'b')], ZERO_FLOOR_CONFIG);
    expect(outcome.spreadCutoff).toBe(0);
    expect(outcome.accepted).toBe(2);
  });

  it('reports a background even while the floor is off, since that is what a value is chosen from', () => {
    const outcome = applyFloors(QUERY, [chunkAt(0.9, 'a'), chunkAt(0.8, 'b'), chunkAt(0.1, 'c')], ZERO_FLOOR_CONFIG);
    expect(outcome.backgroundScore).toBeCloseTo(0.8, 4);
  });

  it('reports no background when nothing scored', () => {
    expect(applyFloors(QUERY, [], SHIPPED_CONFIG).backgroundScore).toBeUndefined();
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

  // The column exists because these two diverge, and the divergence is what stops a reader taking
  // the baseline row's recall as recall of what the model saw.
  it('reports served below accepted when the char budget stops the walk short', () => {
    const wide = [chunkAt(0.9, 'a', 'docA', 400), chunkAt(0.88, 'b', 'docB', 400), chunkAt(0.86, 'c', 'docC', 400)];
    const row = buildFloorSweepRow({ config: ZERO_FLOOR_CONFIG, chunks: wide, queries, charBudget: 600 });
    expect(row.meanAccepted).toBe(3);
    // 400 fits in 600; the second FILLS the remaining 200 (truncated) and is the last injected.
    expect(row.meanServed).toBe(2);
    expect(row.budgetBoundShare).toBe(1);
  });

  it('reports served equal to accepted when the budget never binds', () => {
    const row = buildFloorSweepRow({ config: ZERO_FLOOR_CONFIG, chunks, queries, charBudget: 100_000 });
    expect(row.meanServed).toBe(row.meanAccepted);
    expect(row.budgetBoundShare).toBe(0);
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

  it('counts an emptied POSITIVE as a cost, which only the absolute floor can do', () => {
    const row = buildFloorSweepRow({
      config: { relativeFloorPct: 85, minSimilarityPct: 95 },
      chunks,
      queries,
    });
    expect(row.emptiedPositives).toBe(1);
    expect(row.emptiedNegatives).toBe(0);
  });

  it('counts an emptied NEGATIVE separately from an emptied positive', () => {
    const negativeQuery = [{ id: 'q01', vector: [1, 0], supporting: [] }];
    const row = buildFloorSweepRow({
      config: { relativeFloorPct: 85, minSimilarityPct: 95 },
      chunks,
      queries: negativeQuery,
    });
    expect(row.emptiedNegatives).toBe(1);
    expect(row.emptiedPositives).toBe(0);
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
    expect(row.spreadBoundShare).toBe(0);
    expect(row.meanSpreadCutRank).toBeNull();
    expect(row.acceptedStdDev).toBe(0);
  });

  it('reports the spread floor as unbound when it is off', () => {
    const row = buildFloorSweepRow({ config: ZERO_FLOOR_CONFIG, chunks, queries });
    expect(row.spreadBoundShare).toBe(0);
    expect(row.meanSpreadCutRank).toBeNull();
  });

  it('separates the spread floor cost from the other two', () => {
    // top 0.90, scores 0.90/0.76/0.60, median 0.76 -> span 0.14, 50% down = 0.83: only 0.90 clears.
    const row = buildFloorSweepRow({
      config: { relativeFloorPct: 0, minSimilarityPct: 0, spreadFloorPct: 50 },
      chunks,
      queries,
    });
    expect(row.meanAboveAbsolute).toBe(3);
    expect(row.meanAccepted).toBe(1);
    expect(row.spreadBoundShare).toBe(1);
    expect(row.meanSpreadCutRank).toBe(2);
    expect(row.relativeBoundShare).toBe(0);
  });

  it('reports a zero accepted standard deviation for the constant-volume case this ticket is about', () => {
    // Two questions, same corpus, no gate that responds to either: both accept the whole pool. That
    // is a fixed-size dump, and `sd` is the only column in the row that says so.
    const twoQueries = [
      { id: 'q01', vector: [1, 0], supporting: ['docA'] },
      { id: 'q02', vector: [0, 1], supporting: ['docB'] },
    ];
    const row = buildFloorSweepRow({ config: ZERO_FLOOR_CONFIG, chunks, queries: twoQueries });
    expect(row.meanAccepted).toBe(3);
    expect(row.acceptedStdDev).toBe(0);
  });

  it('reports a non-zero accepted standard deviation once a gate responds to the question', () => {
    // The pair this ticket turns on, over ONE corpus: the ungated row admits the whole pool on both
    // questions (sd 0, a fixed-size dump), and the same corpus under a spread floor admits a
    // different count per question. Two 2-dim queries at right angles see the same chunks with
    // differently-shaped score distributions, which is the cheapest honest way to vary the shape.
    const shaped = [
      chunkAt(0.9, 'n1', 'docA'),
      chunkAt(0.88, 'n2', 'docB'),
      chunkAt(0.86, 'n3', 'docC'),
      chunkAt(0.84, 'n4', 'docD'),
      ...BACKGROUND,
    ];
    const twoQueries = [
      { id: 'q01', vector: [1, 0], supporting: ['docA'] },
      { id: 'q02', vector: [0, 1], supporting: ['docB'] },
    ];
    const ungated = buildFloorSweepRow({ config: ZERO_FLOOR_CONFIG, chunks: shaped, queries: twoQueries });
    expect(ungated.acceptedStdDev).toBe(0);

    const gated = buildFloorSweepRow({
      config: { relativeFloorPct: 0, minSimilarityPct: 0, spreadFloorPct: 50 },
      chunks: shaped,
      queries: twoQueries,
    });
    expect(gated.acceptedStdDev).toBeGreaterThan(0);
  });
});

describe('formatFloorSweepTable', () => {
  const chunks = [chunkAt(0.9, 'a', 'docA'), chunkAt(0.8, 'b', 'docB')];
  const queries = [{ id: 'q01', vector: [1, 0], supporting: ['docA'] }];
  const row = (config: { relativeFloorPct: number; minSimilarityPct: number; spreadFloorPct?: number }) =>
    buildFloorSweepRow({ config, chunks, queries });

  it('renders one row per floor pair under a Markdown header', () => {
    const lines = formatFloorSweepTable([row(ZERO_FLOOR_CONFIG), row(SHIPPED_CONFIG)]).split('\n');
    expect(lines).toHaveLength(4); // header + separator + 2 rows
    expect(lines[0]).toContain('budget-bound');
  });

  it('prints accepted and served as separate columns', () => {
    // Recall and precision score the ACCEPTED set, so collapsing these two back into one column
    // would let the baseline row's recall read as recall of what reached the model.
    const lines = formatFloorSweepTable([row(ZERO_FLOOR_CONFIG)]).split('\n');
    expect(lines[0]).toContain('accepted/q');
    expect(lines[0]).toContain('served/q');
    expect(lines[0]).not.toContain('chunks/q');
  });

  it('prints the relative floor as "off" at 0, but never the absolute one', () => {
    // A 0 relative floor skips the filter entirely. A 0 ABSOLUTE floor is a real line - it rejects
    // negative cosines - so labelling it "off" would claim the baseline row is the whole scored
    // pool when it is not.
    expect(formatFloorSweepTable([row(ZERO_FLOOR_CONFIG)]).split('\n')[2]).toContain('| off | 0% | off |');
  });

  it('prints "never" rather than a rank when the floor cuts nothing', () => {
    // A 0 here would read as "cuts at rank 0", i.e. rejects everything - the opposite of inert.
    expect(formatFloorSweepTable([row(ZERO_FLOOR_CONFIG)]).split('\n')[2]).toContain('never');
  });

  it('shows all three floors with their units', () => {
    expect(
      formatFloorSweepTable([row({ relativeFloorPct: 90, minSimilarityPct: 75, spreadFloorPct: 40 })]).split('\n')[2]
    ).toContain('| 90% | 75% | 40% |');
  });

  it('prints the accepted-count standard deviation, the column that says volume responds at all', () => {
    expect(formatFloorSweepTable([row(ZERO_FLOOR_CONFIG)]).split('\n')[0]).toContain('| sd |');
  });

  it('renders a header even with no rows, so an empty run is visibly empty', () => {
    expect(formatFloorSweepTable([]).split('\n')).toHaveLength(2);
  });

  it('reports "n/a (n=0)" for the false-positive rate with no negatives', () => {
    const lines = formatFloorSweepTable([row(ZERO_FLOOR_CONFIG)]).split('\n');
    expect(lines[0]).toContain('false-positive rate');
    expect(lines[2]).toContain('n/a (n=0)');
  });

  it('prints the false-positive rate with its negatives denominator once one exists', () => {
    const mixedQueries = [
      { id: 'q01', vector: [1, 0], supporting: ['docA'] },
      // Diametrically opposite the reference direction, so its cosine to every chunk is negative -
      // ZERO_FLOOR_CONFIG's absolute floor is 0, which still rejects negatives (see FloorConfig).
      { id: 'q02', vector: [-1, 0], supporting: [] },
    ];
    const mixedRow = buildFloorSweepRow({ config: ZERO_FLOOR_CONFIG, chunks, queries: mixedQueries });
    const lines = formatFloorSweepTable([mixedRow]).split('\n');
    expect(lines[2]).toContain('0.0% (n=1)');
  });

  it('prints the emptied positive and negative counts as separate columns', () => {
    const lines = formatFloorSweepTable([row(SHIPPED_CONFIG)]).split('\n');
    expect(lines[0]).toContain('emptied (pos)');
    expect(lines[0]).toContain('emptied (neg)');
  });

  it('withholds recall and MRR on a negatives-only corpus rather than printing a measured-looking zero', () => {
    const negativesOnly = [
      { id: 'q01', vector: [-1, 0], supporting: [] },
      { id: 'q02', vector: [0, -1], supporting: [] },
    ];
    const negRow = buildFloorSweepRow({ config: ZERO_FLOOR_CONFIG, chunks, queries: negativesOnly });
    const cells = formatFloorSweepTable([negRow]).split('\n')[2].split('|');
    // mean([]) is 0, not NaN, so an unguarded recall/MRR renders as a real measurement of a floor
    // that destroyed retrieval - the one reading a negatives-only sweep must never produce.
    expect(cells.filter(c => c.trim() === 'n/a (n=0)')).toHaveLength(3);
    expect(cells.map(c => c.trim())).not.toContain('0.000');
  });

  it('still reports the false-positive rate on a negatives-only corpus, since that is what it measures', () => {
    const negativesOnly = [{ id: 'q01', vector: [1, 0], supporting: [] }];
    const negRow = buildFloorSweepRow({ config: ZERO_FLOOR_CONFIG, chunks, queries: negativesOnly });
    expect(formatFloorSweepTable([negRow]).split('\n')[2]).toContain('100.0% (n=1)');
  });
});
