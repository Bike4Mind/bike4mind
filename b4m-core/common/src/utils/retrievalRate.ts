import type { PromptMeta } from '../types/entities/PromptMetaTypes';

type RetrievalSummary = NonNullable<PromptMeta['retrieval']>;

/**
 * How often the model retrieves when retrieval is OFFERED rather than forced (#1394).
 *
 * The question this answers is the one that decides whether per-turn retrieval routing is worth
 * building: now that the knowledge tools are offered whenever a session has attached knowledge or
 * a reachable lake (#1383), does the model actually call them? If it already does on the turns
 * that matter, a classifier buys latency and little else.
 *
 * Reads only `promptMeta.retrieval`, never `offeredTools`: `mode: 'optional'` is written by the
 * seed in ChatCompletionProcess exactly when the knowledge tool was offered and forced retrieval
 * was off, so it already carries the offer. Keying on it also excludes agent-mode runs, which
 * write a retrieval summary through persistRunAsQuest but never pass the seed site and so would
 * otherwise land in the denominator with no offer behind them.
 */
export type OptionalPathRetrievalRate = {
  /** Turns the model was offered retrieval on, with nothing forcing it. */
  offeredTurns: number;
  /** Of those, the turns where it chose to retrieve. */
  retrievedTurns: number;
  /** retrievedTurns / offeredTurns, or null when the denominator is empty - never a phantom 0. */
  rate: number | null;
  /**
   * Turns where forced retrieval was ON but a rule suppressed it, leaving the model on the
   * optional path. Counted separately rather than folded into the numbers above: they reach the
   * optional path by a different route, and a routing change would treat them differently.
   */
  forcedSuppressed: {
    turns: number;
    retrievedTurns: number;
    rate: number | null;
    byReason: Record<NonNullable<RetrievalSummary['forcedSkipReason']>, number>;
  };
  /** Forced turns where forced retrieval actually ran. Context for the two figures above. */
  forcedTurns: number;
  /**
   * Turns carrying a retrieval record with no `mode`. These predate the field, so they are
   * reported rather than silently dropped - a rollup whose window straddles the deploy would
   * otherwise understate every population above with no sign that it had.
   */
  unclassifiedTurns: number;
};

const emptyRate = (): OptionalPathRetrievalRate => ({
  offeredTurns: 0,
  retrievedTurns: 0,
  rate: null,
  forcedSuppressed: {
    turns: 0,
    retrievedTurns: 0,
    rate: null,
    byReason: { attached_files: 0, personal_corpus: 0 },
  },
  forcedTurns: 0,
  unclassifiedTurns: 0,
});

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

/**
 * The three fields the fold reads. Narrower than the stored summary on purpose: it lets a caller
 * project just these out of Mongo and leave `dataLakeTags` - which lakes a turn touched - in the
 * database rather than egressing lake identity to build a counter (see the redaction CAUTION on
 * RetrievalSummarySchema).
 */
export type RetrievalRateInput = Pick<RetrievalSummary, 'attempted' | 'mode' | 'forcedSkipReason'>;

/**
 * Fold per-turn retrieval summaries into the rate. Pure: the caller owns the query, the date
 * bounding (see `mode` in RetrievalSummarySchema) and the population it hands over.
 */
export function summarizeOptionalPathRetrieval(
  turns: ReadonlyArray<RetrievalRateInput | undefined | null>
): OptionalPathRetrievalRate {
  const summary = emptyRate();

  for (const turn of turns) {
    if (!turn) continue;

    if (turn.mode === undefined) {
      summary.unclassifiedTurns += 1;
      continue;
    }

    if (turn.mode === 'optional') {
      summary.offeredTurns += 1;
      if (turn.attempted) summary.retrievedTurns += 1;
      continue;
    }

    // A forced turn that a rule suppressed still ends up on the optional path, so `attempted`
    // here means the model called the tool of its own accord - the same signal as above, reached
    // a different way. A forced turn with no skip reason simply ran forced retrieval.
    if (turn.forcedSkipReason) {
      summary.forcedSuppressed.turns += 1;
      summary.forcedSuppressed.byReason[turn.forcedSkipReason] += 1;
      if (turn.attempted) summary.forcedSuppressed.retrievedTurns += 1;
      continue;
    }

    summary.forcedTurns += 1;
  }

  summary.rate = ratio(summary.retrievedTurns, summary.offeredTurns);
  summary.forcedSuppressed.rate = ratio(summary.forcedSuppressed.retrievedTurns, summary.forcedSuppressed.turns);
  return summary;
}
