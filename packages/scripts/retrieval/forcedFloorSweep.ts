/**
 * The configuration sweep for the two FORCED-retrieval relevance floors (#2572, item 2).
 *
 * WHY THIS IS NOT `sweep.ts`. That module sweeps `kbSearchResultTokenBudget` and
 * `kbSearchMinRelevancePct`, the two knobs the `search_knowledge_base` TOOL reads, and
 * `recall-probe.ts` measures them by invoking that tool. Forced retrieval is a different code path
 * that reads neither (`ChatCompletionFeatures.ts`: "it is NOT routed through
 * semanticDataLakeSearch"); it reads `forcedRetrievalRelativeFloorPct` and
 * `forcedRetrievalMinSimilarityPct` instead. Adding those two to `SweepConfig` would have written
 * settings the probed path never reads and printed a table whose rows differ only by noise - the
 * mirror image of the reason `recall-probe.ts` drives the tool rather than a chat turn.
 *
 * WHAT IT MEASURES INSTEAD. Both floors are pure arithmetic over one turn's ranked score pool, so
 * they can be swept offline over captured embedding fixtures - no database, no provider key, no
 * stage, and re-runnable at a new floor pair for free. This is the instrument
 * `MODEL-COMPARISON.md`'s "what the measured bands do to the live cosine floors" section derived by
 * hand: at a given floor, does the gate reject anything at all, at which rank does it start
 * cutting, what does that cost recall, and does it bind before the char budget already did.
 *
 * That last question is the one that makes a floor dormant rather than wrong. A floor cutting at
 * rank 9 when the char budget already stopped at rank 6 changes nothing, and reads like a quality
 * gate regardless.
 *
 * Pure: scoring, filtering and formatting only, so the shape of a sweep and the shape of its report
 * are testable without a fixture. The live driver is `forced-floor-sweep.ts`.
 */

import {
  FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT,
  FORCED_RETRIEVAL_MAX_SCORED_CHUNKS,
  FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_DEFAULT,
  FORCED_RETRIEVAL_RELATIVE_FLOOR_PCT_DEFAULT,
  compareForcedRetrievalRank,
  forcedRetrievalRelativeCutoff,
} from '@bike4mind/common';
import { computeCosineSimilarity } from '@bike4mind/utils';
import { aggregate, scoreQuestion, type Aggregate } from './metrics';
import type { ScorableChunk } from './scoreDistribution';

/**
 * One point in the sweep, in the whole-number percents the two admin settings store - NOT the 0..1
 * fractions the comparison uses. The conversion happens once, in `applyFloors`, mirroring the single
 * division in `ChatCompletionFeatures`' resolver.
 *
 * THE TWO ZEROES ARE NOT THE SAME. Zero on the RELATIVE floor is genuinely off: the cutoff is 0 and
 * the filter branch is skipped. Zero on the ABSOLUTE floor is a floor AT zero - the served path
 * still compares `score >= minSimilarity`, so it rejects every negative cosine, which on a
 * 16-dimension or otherwise wide space is a large share of the corpus. `0:0` is therefore the right
 * baseline row to state a cost against, but it is not the whole scored pool and the table must not
 * label it as though it were.
 */
export type FloorConfig = {
  relativeFloorPct: number;
  minSimilarityPct: number;
};

/**
 * Both floors at zero: the baseline a floor's cost is measured against. Not named "ungated" because
 * it is not - a zero absolute floor still rejects negative cosines. See `FloorConfig`.
 */
export const ZERO_FLOOR_CONFIG: FloorConfig = { relativeFloorPct: 0, minSimilarityPct: 0 };

/** Today's shipped defaults, deliberately behavior-preserving rather than tuned (see #2572 item 4). */
export const SHIPPED_CONFIG: FloorConfig = {
  relativeFloorPct: FORCED_RETRIEVAL_RELATIVE_FLOOR_PCT_DEFAULT,
  minSimilarityPct: FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_DEFAULT,
};

export const formatFloorConfig = (c: FloorConfig): string =>
  `relative=${c.relativeFloorPct}% absolute=${c.minSimilarityPct}%`;

/**
 * Parse `--floors=0:0,85:75,90:75` into sweep points ("relativeFloorPct:minSimilarityPct").
 *
 * Throws rather than skipping a malformed entry, for the reason `parseConfigs` does: a silently
 * dropped point leaves a results table that looks complete and is missing the row someone asked
 * for. The arity and emptiness checks are load-bearing for the same reason there - `Number('')` is
 * 0 and `Number.isInteger(0)` is true, so "85:" would otherwise run an ungated absolute floor under
 * the name of the 75 that was asked for.
 */
export function parseFloorConfigs(spec: string): FloorConfig[] {
  const configs = spec
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      const components = part.split(':');
      if (components.length !== 2) {
        throw new Error(
          `Bad floor pair "${part}": expected exactly "relativeFloorPct:minSimilarityPct", ` +
            `got ${components.length} component(s)`
        );
      }
      const [relative, absolute] = components;
      const relativeFloorPct = Number(relative);
      const minSimilarityPct = Number(absolute);
      if (
        relative.trim() === '' ||
        !Number.isInteger(relativeFloorPct) ||
        relativeFloorPct < 0 ||
        relativeFloorPct > 100
      ) {
        throw new Error(`Bad relative floor in "${part}": expected an integer percent 0-100, got "${relative}"`);
      }
      if (
        absolute.trim() === '' ||
        !Number.isInteger(minSimilarityPct) ||
        minSimilarityPct < 0 ||
        minSimilarityPct > 100
      ) {
        throw new Error(`Bad absolute floor in "${part}": expected an integer percent 0-100, got "${absolute}"`);
      }
      return { relativeFloorPct, minSimilarityPct };
    });
  if (configs.length === 0) throw new Error('--floors listed no configurations');

  const seen = new Set<string>();
  for (const c of configs) {
    const key = formatFloorConfig(c);
    // A repeated point runs the whole query set twice for two rows that can only differ by noise,
    // which reads as instability in the measurement rather than a duplicated input.
    if (seen.has(key)) throw new Error(`Duplicate floor pair in --floors: ${key}`);
    seen.add(key);
  }
  return configs;
}

/** A chunk to gate. `charLength` is carried so the sweep can say whether the budget bound first. */
export type FloorScorableChunk = ScorableChunk & { charLength: number };

/** Which gate actually removed something on one query. `budget` means neither floor was reached. */
export type BindingGate = 'none' | 'absolute' | 'relative' | 'both';

/** One query's pass through both floors, with the diagnostics a tuning decision reads. */
export type FloorOutcome = {
  queryId: string;
  /** Finite-scored chunks, before either floor. NaN cosines are dropped as the served path drops them. */
  scoredCount: number;
  /** The turn's best score across the whole pool. -1 when nothing scored, matching the served sentinel. */
  topScore: number;
  relativeCutoff: number;
  /** Survivors of the absolute floor and the pool cap: the served path's `preRelativeFloorCandidates`. */
  aboveAbsolute: number;
  /**
   * Candidates the absolute floor admitted and `FORCED_RETRIEVAL_MAX_SCORED_CHUNKS` then discarded.
   * Reported rather than absorbed into `aboveAbsolute`: once this is non-zero the floors are being
   * measured over a truncated pool, which is a caveat on the row and not a property of either floor.
   */
  cappedOut: number;
  /** Survivors of both floors: the served path's `postRelativeFloorCandidates`. */
  accepted: number;
  /** Distinct parent documents of the accepted set, best-first - what `metrics.ts` scores. */
  acceptedDocIds: string[];
  /**
   * 1-based rank at which the relative floor starts cutting, or null when it cuts nothing. THE
   * number this sweep exists for: a floor whose cut rank sits past where the char budget already
   * stopped is dormant, however strict it looks.
   */
  cutRank: number | null;
  /** Chars the budget walk would admit from the accepted set, in rank order. */
  charsAdmitted: number;
  /** Rank the char budget stops at, or null when the accepted set fits inside it. */
  budgetStopRank: number | null;
  binding: BindingGate;
};

/**
 * Gate one query's chunks through both floors, in the served path's order.
 *
 * MIRRORS `KnowledgeRetrievalFeature`'s scan step for step, and shares its arithmetic rather than
 * restating it: `computeCosineSimilarity` for the scores, `compareForcedRetrievalRank` for the tie
 * order that decides who survives the cap, `forcedRetrievalRelativeCutoff` for the multiply. What
 * remains local is the absolute floor's single `>=` comparison and the cap's `slice`.
 *
 * The order is not interchangeable. The absolute floor runs DURING the scan, so the pool is capped
 * to the top `FORCED_RETRIEVAL_MAX_SCORED_CHUNKS` of what cleared it; the relative floor runs after,
 * because it needs the turn's final top score. `topScore` therefore tracks every finite scored
 * candidate, including ones the absolute floor rejected - it is read one line before that
 * `continue`. That only matters when nothing clears the absolute floor at all, since the global
 * maximum is itself in the pool whenever the pool is non-empty.
 */
export function applyFloors(
  query: { id: string; vector: number[] },
  chunks: readonly FloorScorableChunk[],
  config: FloorConfig,
  charBudget: number = FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT
): FloorOutcome {
  const minSimilarity = config.minSimilarityPct / 100;
  const relativeFloor = config.relativeFloorPct / 100;

  const scored = chunks
    .map(chunk => ({ chunk, score: computeCosineSimilarity(query.vector, chunk.vector) }))
    // A zero-magnitude vector makes cosine NaN, and NaN fails every comparison below - it would
    // slip past the floors and sort ahead of real hits.
    .filter(c => Number.isFinite(c.score));

  // -1 rather than 0 when nothing scored, matching the served path's sentinel so a starved turn
  // reads the same in both places.
  const topScore = scored.reduce((best, c) => (c.score > best ? c.score : best), -1);

  // Kept separate from `ranked` because the cap also removes candidates, and attributing its cut to
  // the absolute floor would name the wrong gate in `binding` on any corpus larger than the cap.
  const aboveAbsolute = scored
    .filter(c => c.score >= minSimilarity)
    .sort((a, b) =>
      compareForcedRetrievalRank(
        { score: a.score, fileId: a.chunk.docId, chunkId: a.chunk.chunkId },
        { score: b.score, fileId: b.chunk.docId, chunkId: b.chunk.chunkId }
      )
    );
  // The served path trims mid-scan whenever the pool exceeds the cap, which retains the same global
  // top-N a single sort-then-slice does: a candidate is dropped only once N strictly better ones
  // exist, and those are never themselves all dropped.
  const ranked = aboveAbsolute.slice(0, FORCED_RETRIEVAL_MAX_SCORED_CHUNKS);

  const relativeCutoff = forcedRetrievalRelativeCutoff(topScore, relativeFloor);
  const accepted = relativeCutoff > 0 ? ranked.filter(c => c.score >= relativeCutoff) : ranked;

  const seen = new Set<string>();
  const acceptedDocIds = accepted
    .map(c => c.chunk.docId)
    // Forward dedupe (keep the best-scoring occurrence), because reciprocalRank reads this order.
    .filter(id => (seen.has(id) ? false : (seen.add(id), true)));

  // The served path's budget walk, with one shortcut. It breaks when `used >= budget` and otherwise
  // slices the chunk to whatever remains, so the first candidate that FILLS OR OVERRUNS the
  // remaining budget is the last one injected - it exhausts the budget (truncated, if it overran)
  // and every later candidate meets the break immediately. Stopping there is the same character
  // count, and its rank is the honest answer to "where did the budget bind".
  let charsAdmitted = 0;
  let budgetStopRank: number | null = null;
  for (const [index, candidate] of accepted.entries()) {
    const remaining = charBudget - charsAdmitted;
    if (candidate.chunk.charLength >= remaining) {
      budgetStopRank = index + 1;
      charsAdmitted += remaining;
      break;
    }
    charsAdmitted += candidate.chunk.charLength;
  }

  const absoluteCut = scored.length - aboveAbsolute.length;
  // The single definition of "the relative floor bound on this query". `buildFloorSweepRow` reads it
  // back off `cutRank` rather than recomputing, so the row's `relativeBoundShare` and the outcome's
  // `binding` cannot disagree about whether the floor did anything.
  const cutRank = accepted.length < ranked.length ? accepted.length + 1 : null;
  return {
    queryId: query.id,
    scoredCount: scored.length,
    topScore,
    relativeCutoff,
    aboveAbsolute: ranked.length,
    cappedOut: aboveAbsolute.length - ranked.length,
    accepted: accepted.length,
    acceptedDocIds,
    cutRank,
    charsAdmitted,
    budgetStopRank,
    binding:
      absoluteCut > 0 && cutRank !== null
        ? 'both'
        : absoluteCut > 0
          ? 'absolute'
          : cutRank !== null
            ? 'relative'
            : 'none',
  };
}

/** One floor pair's row: what the gate admitted, what it cost, and whether it bound at all. */
export type FloorSweepRow = FloorConfig & {
  queries: number;
  /** Mean chunks surviving both floors. The pool the char-budget walk then spends. */
  meanAccepted: number;
  /**
   * Mean chunks the budget walk actually injects, which is what reaches the model. Reported beside
   * `meanAccepted` because the two diverge hard at a low floor: on a corpus of short chunks the
   * budget can stop at a small fraction of an accepted set of hundreds, and reading the accepted
   * count as the served count overstates a floor's cost by that whole factor.
   */
  meanServed: number;
  /** Mean chunks surviving the absolute floor alone, so the relative floor's own cost is visible. */
  meanAboveAbsolute: number;
  /**
   * Share of queries where the RELATIVE floor removed at least one candidate. A floor at 0.0% here
   * is inert on this corpus - it provides no protection while reading like a quality gate, which is
   * the exact failure the relative floor was introduced to fix in the absolute one.
   */
  relativeBoundShare: number;
  /** Mean 1-based rank the relative floor cuts at, over the queries where it cut anything. */
  meanCutRank: number | null;
  /**
   * Share of queries whose accepted set the char budget truncates. Read against `meanCutRank`: a
   * floor cutting past where the budget already stopped changes nothing that reaches the model.
   */
  budgetBoundShare: number;
  /**
   * Queries the floors emptied outright. A floor cannot starve a turn that scored anything (see
   * `forcedRetrievalRelativeCutoff`), so a non-zero count here is the absolute floor's doing.
   */
  emptiedQueries: number;
  /**
   * Queries whose pool the cap truncated before either floor ran. Non-zero invalidates nothing, but
   * the floors were measured over the top `FORCED_RETRIEVAL_MAX_SCORED_CHUNKS` rather than the whole
   * corpus, so `cut @` is a rank within that pool. The driver warns when it is non-zero.
   */
  cappedQueries: number;
  /**
   * Recall, precision and MRR of the ACCEPTED set against the committed ground truth - the
   * population the floors gate, deliberately not the shorter prefix the char budget then injects.
   * A floor has to be judged on what it admits, or lowering the budget would read as a better
   * floor. The consequence is that a row with a high `budget-bound` share reports quality over a
   * candidate set wider than the model saw, which is what `budget-bound` is in the table to say.
   */
  quality: Aggregate;
};

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Gate every query at one floor pair and roll it up.
 *
 * `supporting` is the hand-authored ground truth keyed by query id (`corpus.ts`); a query with an
 * empty supporting set is a deliberate negative, and `metrics.ts` scores it as one.
 */
export function buildFloorSweepRow(args: {
  config: FloorConfig;
  chunks: readonly FloorScorableChunk[];
  queries: readonly { id: string; vector: number[]; supporting: readonly string[] }[];
  charBudget?: number;
}): FloorSweepRow {
  const outcomes = args.queries.map(q => applyFloors(q, args.chunks, args.config, args.charBudget));
  const cutRanks = outcomes.map(o => o.cutRank).filter((r): r is number => r !== null);
  return {
    ...args.config,
    queries: outcomes.length,
    meanAccepted: mean(outcomes.map(o => o.accepted)),
    // `budgetStopRank` is the rank of the LAST injected candidate (the one that fills or overruns
    // the remaining budget), so it is the served count itself - not one past it.
    meanServed: mean(outcomes.map(o => o.budgetStopRank ?? o.accepted)),
    meanAboveAbsolute: mean(outcomes.map(o => o.aboveAbsolute)),
    relativeBoundShare: outcomes.length === 0 ? 0 : outcomes.filter(o => o.cutRank !== null).length / outcomes.length,
    meanCutRank: cutRanks.length === 0 ? null : mean(cutRanks),
    budgetBoundShare:
      outcomes.length === 0 ? 0 : outcomes.filter(o => o.budgetStopRank !== null).length / outcomes.length,
    emptiedQueries: outcomes.filter(o => o.scoredCount > 0 && o.accepted === 0).length,
    cappedQueries: outcomes.filter(o => o.cappedOut > 0).length,
    quality: aggregate(outcomes.map((o, i) => scoreQuestion(o.acceptedDocIds, new Set(args.queries[i].supporting)))),
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** See `sweep.ts`' `precisionCell`: precision's denominator moves with the configuration. */
const precisionCell = (a: Aggregate): string =>
  a.precisionScored === 0 ? 'n/a (n=0)' : `${pct(a.precision)} (n=${a.precisionScored})`;

/**
 * Render the sweep as a Markdown table for pasting into the ticket.
 *
 * `bound` and `cut @` are the two columns a floor decision actually turns on, and neither is
 * derivable from recall: a floor can leave recall untouched because it is cutting nothing (inert)
 * or because it is cutting only noise (working), and only the binding columns separate those.
 * `budget-bound` is here because it can make a cut rank irrelevant - the char budget having already
 * stopped shorter than the floor does. `accepted/q` against `served/q` is the same warning as a
 * ratio rather than a share: recall and precision are over `accepted`, so the wider that gap, the
 * more of the measured set never reached the model.
 */
export function formatFloorSweepTable(rows: readonly FloorSweepRow[]): string {
  const header = [
    '| relative | absolute | accepted/q | served/q | pre-rel | bound | cut @ | budget-bound | emptied | recall | precision | MRR |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  const body = rows.map(r =>
    [
      '',
      // Only the relative floor can be genuinely off. A 0 absolute floor is a real line in cosine
      // space - it rejects negatives - so printing it as "off" would overstate the baseline row.
      r.relativeFloorPct === 0 ? 'off' : `${r.relativeFloorPct}%`,
      `${r.minSimilarityPct}%`,
      r.meanAccepted.toFixed(1),
      r.meanServed.toFixed(1),
      r.meanAboveAbsolute.toFixed(1),
      pct(r.relativeBoundShare),
      r.meanCutRank === null ? 'never' : r.meanCutRank.toFixed(1),
      pct(r.budgetBoundShare),
      String(r.emptiedQueries),
      pct(r.quality.recall),
      precisionCell(r.quality),
      r.quality.mrr.toFixed(3),
      '',
    ].join(' | ')
  );
  return [...header, ...body].join('\n');
}
