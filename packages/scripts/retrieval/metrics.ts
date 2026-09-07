/**
 * Retrieval metrics for the `search_knowledge_base` recall probe (#1993).
 *
 * Pure and dependency-free, deliberately mirroring `b4m-core/memory/src/eval/metrics.ts` so the two
 * evals speak one vocabulary: they take an ORDERED list of document ids (what retrieval actually
 * served, best first) plus the ids that genuinely support an answer, and score the outcome. Nothing
 * here knows about embeddings, Mongo, or the tool - which is what lets the same numbers compare one
 * budget/floor configuration against another on identical footing.
 *
 * The unit is a DOCUMENT (a help slug), not a passage. #1831 measured "3.9 documents of 47" and
 * "16% of the supporting set", and the whole question this ticket asks - does a wider budget reach
 * more of the material that could support the answer - is a document-level question. Several
 * passages from one document are one document reached, not several.
 */

/**
 * Fraction of the supporting documents that retrieval actually served. THE headline number: a
 * document the model never sees cannot support its answer, however well it was ranked.
 *
 * A question with an empty supporting set (a NEGATIVE - see the corpus) scores 1: there was nothing
 * to find, so nothing was missed. Read those questions through `falsePositiveRate` instead, which is
 * the metric that can actually fail on them.
 */
export function recall(served: readonly string[], supporting: ReadonlySet<string>): number {
  if (supporting.size === 0) return 1;
  const found = served.filter(id => supporting.has(id)).length;
  return found / supporting.size;
}

/**
 * Fraction of what retrieval served that was actually supporting. The counterweight to recall, and
 * the reason this ticket cannot just raise the budget until recall peaks: serving every document
 * scores a perfect recall and a terrible precision, and precision is what governs how much
 * irrelevant material the model is invited to answer from.
 *
 * Serving nothing scores 1 - nothing irrelevant was served. That is only meaningful next to recall,
 * which scores 0 on the same outcome whenever a supporting set exists.
 */
export function precision(served: readonly string[], supporting: ReadonlySet<string>): number {
  if (served.length === 0) return 1;
  return served.filter(id => supporting.has(id)).length / served.length;
}

/**
 * Did retrieval serve at least one supporting document? #1831's "at-least-one-relevant hit rate"
 * was 93% against a 16% recall - the finding that retrieval is not blind, it finds something and
 * then stops. Kept so this probe can state whether that gap still holds.
 */
export function hitRate(served: readonly string[], supporting: ReadonlySet<string>): number {
  if (supporting.size === 0) return 0;
  return served.some(id => supporting.has(id)) ? 1 : 0;
}

/**
 * Reciprocal rank of the FIRST supporting document (1 = served first, 0 = never served). Rewards
 * ordering, which a token budget silently depends on: a budget keeps a rank-ordered prefix, so a
 * budget can only be set safely if the ranking puts supporting documents near the front.
 */
export function reciprocalRank(served: readonly string[], supporting: ReadonlySet<string>): number {
  const i = served.findIndex(id => supporting.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

export type QuestionOutcome = {
  recall: number;
  precision: number;
  hit: number;
  rr: number;
  /** Distinct documents served. #1831's headline was this number (3.9) against a 47-document lake. */
  documentsServed: number;
  /** True when nothing supports this question - scored by `falsePositiveRate`, not by recall. */
  isNegative: boolean;
};

/** Score one question's served documents against its supporting set. */
export function scoreQuestion(served: readonly string[], supporting: ReadonlySet<string>): QuestionOutcome {
  // Rank order matters to reciprocalRank, so dedupe forward (keep first occurrence) rather than
  // through a Set round-trip, which would preserve insertion order only by accident of the input.
  const seen = new Set<string>();
  const distinct = served.filter(id => (seen.has(id) ? false : (seen.add(id), true)));
  return {
    recall: recall(distinct, supporting),
    precision: precision(distinct, supporting),
    hit: hitRate(distinct, supporting),
    rr: reciprocalRank(distinct, supporting),
    documentsServed: distinct.length,
    isNegative: supporting.size === 0,
  };
}

export type Aggregate = {
  /** Questions with a non-empty supporting set - the denominator for recall/precision/hit/mrr. */
  positives: number;
  /** Questions nothing supports - the denominator for falsePositiveRate. */
  negatives: number;
  recall: number;
  /**
   * Averaged over the positives that actually SERVED something, not over all of them - read it
   * next to `precisionScored`, which is that denominator.
   *
   * A positive that served nothing scores a vacuous `precision` of 1 (nothing irrelevant was
   * served). Pooling those in would make precision climb as the floor got more aggressive, since
   * an emptied question would contribute a 1.0 rather than being excluded - so precision would
   * reward the very trade it exists to price. Recall still scores those questions 0, which is
   * where an over-aggressive floor is supposed to show up.
   */
  precision: number;
  /** Positives that served at least one document - the denominator `precision` was averaged over. */
  precisionScored: number;
  hitRate: number;
  mrr: number;
  meanDocumentsServed: number;
  /**
   * Fraction of NEGATIVE questions where retrieval served anything at all. The metric the relevance
   * floor exists to move: with the floor off, a negative question still gets the top-k nearest
   * chunks, however unrelated. A floor that trades a little recall for a large drop here is the
   * outcome this ticket is looking for, and no other metric can see it.
   */
  falsePositiveRate: number;
};

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Aggregate per-question outcomes into one configuration's row.
 *
 * Positives and negatives are averaged SEPARATELY and never pooled: recall is vacuously 1 on a
 * negative, so pooling would let a corpus with many negatives report a high recall that no positive
 * question earned. `meanDocumentsServed` spans every question, since "how much did retrieval emit"
 * is meaningful on both.
 *
 * Precision narrows the denominator once more, to the positives that served something - see the
 * field's own comment for why a vacuous 1.0 there would invert the metric's meaning.
 */
export function aggregate(outcomes: readonly QuestionOutcome[]): Aggregate {
  const positives = outcomes.filter(o => !o.isNegative);
  const negatives = outcomes.filter(o => o.isNegative);
  const precisionScored = positives.filter(o => o.documentsServed > 0);
  return {
    positives: positives.length,
    negatives: negatives.length,
    recall: mean(positives.map(o => o.recall)),
    precision: mean(precisionScored.map(o => o.precision)),
    precisionScored: precisionScored.length,
    hitRate: mean(positives.map(o => o.hit)),
    mrr: mean(positives.map(o => o.rr)),
    meanDocumentsServed: mean(outcomes.map(o => o.documentsServed)),
    falsePositiveRate: mean(negatives.map(o => (o.documentsServed > 0 ? 1 : 0))),
  };
}
