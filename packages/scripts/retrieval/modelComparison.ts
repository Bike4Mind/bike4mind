/**
 * Score every captured model at every requested width against the committed ground truth.
 *
 * This is the half of the comparison that needs no credentials: the capture already paid to embed,
 * and everything from here is arithmetic over the fixture. So the decision this ticket exists to
 * inform is reproducible by anyone holding the fixture files, and re-analysing at a new width or
 * after a metrics fix costs nothing.
 *
 * WIDTHS ARE FREE, MODELS ARE NOT. `text-embedding-3-*` are Matryoshka, so one full-width capture
 * yields every narrower arm (see `deriveArm`). 3-small at 1536/512 and 3-large at 3072/1536/512 are
 * five arms off two API calls - which is what makes `3-large@1536` a first-class arm rather than a
 * curiosity: truncated to 1536 it costs exactly the storage of `3-small@1536` and every cosine is
 * the same width, so the only remaining difference is the one-off embed price.
 */

import { PROBE_QUESTIONS } from './corpus';
import { deriveArm, loadEmbeddingFixture, type EmbeddingFixture } from './embeddingFixture';
import { buildArmRow, formatArmSummary, formatComparisonTable, type ArmRow } from './scoreDistribution';

const SUPPORTING_BY_ID = new Map(PROBE_QUESTIONS.map(q => [q.id, q.supporting]));

/**
 * Every fixture must describe the SAME corpus. Two arms measured over different lakes differ by the
 * corpus as much as by the model, and the table gives no hint of it - the rows simply sit next to
 * each other looking comparable. This is the one precondition the arithmetic cannot recover from.
 */
export function assertSameCorpus(fixtures: readonly EmbeddingFixture[]): void {
  const corpora = [...new Set(fixtures.map(f => f.corpus))];
  if (corpora.length > 1) {
    throw new Error(
      `Fixtures describe different corpora (${corpora.join(', ')}). Two arms measured over ` +
        'different lakes differ by the corpus as much as by the model, and the table cannot show it.'
    );
  }
}

/**
 * Resolve a fixture's queries against the committed ground truth.
 *
 * A query id with no entry in `corpus.ts` is an ERROR, not a skip. Silently dropping it would shrink
 * the question set for one arm only - and an arm scored on fewer, or easier, questions reads as a
 * better model.
 */
export function resolveQueries(fixture: EmbeddingFixture): { id: string; vector: number[]; supporting: string[] }[] {
  const unknown = fixture.queries.filter(q => !SUPPORTING_BY_ID.has(q.id)).map(q => q.id);
  if (unknown.length > 0) {
    throw new Error(
      `Fixture "${fixture.corpus}" carries query id(s) with no ground truth in corpus.ts: ` +
        `${unknown.join(', ')}. Re-capture against the current PROBE_QUESTIONS.`
    );
  }
  return fixture.queries.map(q => ({ id: q.id, vector: q.vector, supporting: SUPPORTING_BY_ID.get(q.id) ?? [] }));
}

/**
 * Build one row per (fixture, width) arm.
 *
 * A width wider than a fixture's capture is skipped rather than thrown on: a run naming
 * `3072,1536,512` is asking for every width that applies, and 3072 simply does not apply to a
 * 1536-dim capture of 3-small. Widening would be an error (`deriveArm` throws); omitting the row is
 * the correct reading of the request.
 */
export function compareArms(fixtures: readonly EmbeddingFixture[], widths: readonly number[]): ArmRow[] {
  assertSameCorpus(fixtures);
  const rows: ArmRow[] = [];

  for (const fixture of fixtures) {
    const queries = resolveQueries(fixture);
    if (queries.length === 0) throw new Error(`Fixture "${fixture.corpus}" (${fixture.model}) carries no queries.`);

    for (const width of [...widths].sort((a, b) => b - a)) {
      if (width > fixture.dims) continue;
      const arm = deriveArm(fixture, width);
      const byId = new Map(arm.queries.map(q => [q.id, q.vector]));
      rows.push(
        buildArmRow({
          arm: arm.arm,
          chunks: arm.chunks,
          filesInScope: arm.filesInScope,
          chunksExcluded: arm.chunksExcluded,
          filesExcluded: arm.filesExcluded,
          queries: queries.map(q => ({ ...q, vector: byId.get(q.id) ?? q.vector })),
        })
      );
    }
  }

  if (rows.length === 0) {
    throw new Error(`No arm matched widths ${widths.join(', ')}. Every requested width exceeds the capture width.`);
  }
  return rows;
}

/** Parse and validate raw fixture JSON, then compare. Separate so callers can supply loaded fixtures. */
export function compareFromRaw(raws: readonly unknown[], widths: readonly number[]): ArmRow[] {
  return compareArms(raws.map(loadEmbeddingFixture), widths);
}

/**
 * The full report: one published-shaped block per arm, then the cross-arm table.
 *
 * Both, not either. The per-arm block is what compares against the published prod probe; the table
 * is what compares the arms against each other. A reader needs the first to trust the second.
 */
export function formatComparison(rows: readonly ArmRow[]): string {
  const notes = [
    'Band width and spread are the geometry; recall/prec/hit/mrr are whether it bought better retrieval.',
    'Scores are exact cosine over the captured chunks, NOT the ANN path prod measured through.',
  ];
  // The baseline arm reuses only the chunks whose stamp names its model, while an embed arm covers
  // every chunk in the lake. When those differ, the bands are measured over different corpora and
  // the comparison is not apples to apples - `chunks` is in the table, but nobody reads a column
  // they were not told to.
  const sizes = [...new Set(rows.map(r => r.chunksScored))];
  if (sizes.length > 1) {
    notes.push(
      `ARMS COVER DIFFERENT CHUNK SETS (${sizes.join(' vs ')} chunks). The bands below are measured ` +
        'over different corpora, so band width is not directly comparable across them. This is the ' +
        'expected shape when a --reuse-stored-vectors baseline excludes unlabeled chunks that the ' +
        'embedded arms re-embed; check the skipped column before drawing a model conclusion.'
    );
  }
  // corpus.ts names help slugs, so a capture of any other lake has no ground truth to score against.
  // Saying so beats printing quality columns of n/a and leaving the reader to work out why.
  if (rows.some(r => !r.groundTruthApplies)) {
    notes.push(
      'GROUND TRUTH DOES NOT DESCRIBE THIS CORPUS: no captured document matches a supporting slug in ' +
        'corpus.ts, so recall/prec/hit/mrr read n/a. The geometry columns need no labels and remain ' +
        'valid - read the band, the spread and the posTop/negTop gap, and ignore the rest.'
    );
  }
  return [...rows.map(r => formatArmSummary(r)), '', formatComparisonTable(rows), '', ...notes].join('\n\n');
}
