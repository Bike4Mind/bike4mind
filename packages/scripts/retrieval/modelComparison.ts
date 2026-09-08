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
import {
  corpusRegime,
  deriveArm,
  isLongDocumentRegime,
  isTruncatableModel,
  loadEmbeddingFixture,
  PROD_REGIME_REFERENCE,
  type EmbeddingFixture,
} from './embeddingFixture';
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
 * Every fixture must carry the SAME question set, by id.
 *
 * `resolveQueries` only rejects an id `corpus.ts` does not know; it cannot see a fixture carrying
 * FEWER known ids. So a fixture captured before `PROBE_QUESTIONS` grew loads clean beside a fresh
 * one, and the table compares 25 questions against 30 with no column that would say so. That is
 * verbatim the hazard `resolveQueries`' own docblock names: an arm scored on fewer, or easier,
 * questions reads as a better model.
 *
 * Compared as id SETS, not counts - two same-size fixtures with different ids are the identical bug,
 * and a length check waves it through.
 */
export function assertSameQuerySet(fixtures: readonly EmbeddingFixture[]): void {
  const keyed = fixtures.map(f => ({ fixture: f, key: [...new Set(f.queries.map(q => q.id))].sort().join(',') }));
  const distinct = [...new Set(keyed.map(k => k.key))];
  if (distinct.length > 1) {
    throw new Error(
      'Fixtures carry different question sets: ' +
        `${keyed.map(k => `${k.fixture.model}@${k.fixture.dims} (${k.fixture.queries.length} queries)`).join(', ')}. ` +
        'An arm scored on fewer, or different, questions reads as a better model and the table cannot ' +
        'show it. Re-capture every arm against the current PROBE_QUESTIONS.'
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
 * Which widths this fixture actually has arms at, widest first.
 *
 * A width wider than the capture is skipped rather than thrown on: a run naming `3072,1536,512` is
 * asking for every width that applies, and 3072 simply does not apply to a 1536-dim capture of
 * 3-small. Widening would be an error (`deriveArm` throws); omitting the row is the correct reading.
 *
 * A non-Matryoshka capture has exactly ONE honest arm - its own width - and it gets that arm
 * whatever was asked for. Two reasons it is not merely filtered: a truncated ada-002 prefix would
 * render as a first-class row beside a legitimate `3-small@512`, and the ada-002 baseline is the arm
 * the instrument check is read off, so it must not vanish because the width list omitted 1536.
 */
export function applicableWidths(fixture: EmbeddingFixture, widths: readonly number[]): number[] {
  if (!isTruncatableModel(fixture.model)) return [fixture.dims];
  return [...widths].sort((a, b) => b - a).filter(width => width <= fixture.dims);
}

/** Build one row per (fixture, width) arm. */
export function compareArms(fixtures: readonly EmbeddingFixture[], widths: readonly number[]): ArmRow[] {
  assertSameCorpus(fixtures);
  assertSameQuerySet(fixtures);
  const rows: ArmRow[] = [];

  for (const fixture of fixtures) {
    const queries = resolveQueries(fixture);
    if (queries.length === 0) throw new Error(`Fixture "${fixture.corpus}" (${fixture.model}) carries no queries.`);

    // Some requested widths not applying is the intended reading (see applicableWidths); NONE
    // applying is different - the fixture would be absent from the table while the report still
    // looked complete, quietly comparing one fewer model than the command named.
    const fixtureWidths = applicableWidths(fixture, widths);
    if (fixtureWidths.length === 0) {
      throw new Error(
        `Fixture "${fixture.corpus}" (${fixture.model} at ${fixture.dims} dims) has no arm at any of the ` +
          `requested widths (${widths.join(', ')}): every one exceeds the capture. Include ${fixture.dims} ` +
          'or narrower, or drop the fixture.'
      );
    }
    for (const width of fixtureWidths) {
      const arm = deriveArm(fixture, width);
      const byId = new Map(arm.queries.map(q => [q.id, q.vector]));
      rows.push(
        buildArmRow({
          arm: arm.arm,
          chunks: arm.chunks,
          filesInScope: arm.filesInScope,
          chunksExcluded: arm.chunksExcluded,
          filesExcluded: arm.filesExcluded,
          filesUnreachable: arm.filesUnreachable,
          queries: queries.map(q => ({ ...q, vector: byId.get(q.id) ?? q.vector })),
        })
      );
    }
  }

  if (rows.length === 0) throw new Error('No fixtures to compare.');
  return rows;
}

/** Parse and validate raw fixture JSON, then compare. Separate so callers can supply loaded fixtures. */
export function compareFromRaw(raws: readonly unknown[], widths: readonly number[]): ArmRow[] {
  return compareArms(raws.map(loadEmbeddingFixture), widths);
}

/** Parse raw fixture JSON, compare it, and render the report - what the CLI does, in one call. */
export function reportFromRaw(raws: readonly unknown[], widths: readonly number[]): string {
  const fixtures = raws.map(loadEmbeddingFixture);
  return formatComparison(compareArms(fixtures, widths), fixtures);
}

/**
 * The full report: one published-shaped block per arm, then the cross-arm table.
 *
 * Both, not either. The per-arm block is what compares against the published prod probe; the table
 * is what compares the arms against each other. A reader needs the first to trust the second.
 *
 * `fixtures` is what the arms were derived from, and it is optional only so the row-level tests can
 * call this without one. Pass it: the corpus-regime gate and the non-Matryoshka note are properties
 * of the CAPTURE, not of a row, and the whole point of the credential split is that someone else
 * scores these fixtures later - they see this report and nothing else.
 */
export function formatComparison(rows: readonly ArmRow[], fixtures: readonly EmbeddingFixture[] = []): string {
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
        'corpus.ts, so recall/prec/hit/mrr read n/a - and so do posTop/negTop, which are partitioned ' +
        'by the same labels. Read the band and the spread, which need no labels, and ignore the rest.'
    );
  }
  // Partial overlap is the likelier accident than none, and it does NOT trip the flag above: one
  // shared slug renders a full set of quality columns off a fraction of the ground truth. Stating
  // the fraction fixes the reading without pretending the numbers are unusable.
  const partial = rows.filter(r => r.groundTruthApplies && r.groundTruthCoverage.matched < r.groundTruthCoverage.total);
  if (partial.length > 0) {
    const { matched, total } = partial[0].groundTruthCoverage;
    notes.push(
      `GROUND TRUTH ONLY PARTLY DESCRIBES THIS CORPUS (${matched} of ${total} supporting documents ` +
        'captured). recall and prec are computed against the full supporting set, so they are bounded ' +
        'well below 1 by the corpus rather than by the model. Compare arms to each other, not to 1.'
    );
  }
  // The gate the ticket exists over, restated where the verdict is actually read. The capture warns
  // about it on its own stdout, which the person scoring the fixture later never sees - so a clean
  // table would be the only thing in front of them.
  const shortCorpora = fixtures
    .map(f => ({ model: f.model, regime: corpusRegime(f.chunks, f.filesInScope) }))
    .filter(f => !isLongDocumentRegime(f.regime));
  if (shortCorpora.length > 0) {
    notes.push(
      `NOT THE LONG-DOCUMENT REGIME (median chunk ${shortCorpora.map(f => f.regime.medianChars).join(', ')} ` +
        `chars against a prod reference of ${PROD_REGIME_REFERENCE.medianChars}). text-embedding-3-small ` +
        'was chosen on short facts, and the argument for it is exactly the one that does not transfer ' +
        'to long prose. A model verdict read off this capture inherits that bias - capture a ' +
        'production lake instead.'
    );
  }
  // A non-MRL capture ignores --widths entirely, and silence would read as "no narrower arm was asked
  // for" rather than "a narrower arm of this model would not be an embedding".
  const nonMatryoshka = fixtures.filter(f => !isTruncatableModel(f.model)).map(f => `${f.model}@${f.dims}`);
  if (nonMatryoshka.length > 0) {
    notes.push(
      `SCORED AT CAPTURE WIDTH ONLY (${nonMatryoshka.join(', ')}): not a Matryoshka model, so a ` +
        'narrower prefix of its vectors is not an embedding. Any requested width was ignored for it; ' +
        'only text-embedding-3-small and text-embedding-3-large yield width arms.'
    );
  }
  return [...rows.map(r => formatArmSummary(r)), '', formatComparisonTable(rows), '', ...notes].join('\n\n');
}
