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
  /** Of those, the turns where it chose to retrieve - see MODEL_INITIATED_SURFACES for "chose". */
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
    /** Of those, the turns where the model then reached for the corpus itself. */
    retrievedTurns: number;
    rate: number | null;
    byReason: Record<NonNullable<RetrievalSummary['forcedSkipReason']>, number>;
  };
  /**
   * Forced turns with no suppression recorded. Context for the two figures above, and NOT a count
   * of turns where retrieval ran: the seed marks a turn `forced` before the arm executes, so a
   * forced turn that exited at the empty-query guard (nothing to retrieve about) lands here too.
   * Check `attempted` on the turns themselves if you need "ran", not this bucket.
   */
  forcedTurns: number;
  /**
   * Turns carrying a retrieval record with no `mode`, reported rather than silently dropped - a
   * rollup that swallowed them would understate every population above with no sign that it had.
   *
   * Three sources, and only the first is historical: turns recorded before `mode` shipped;
   * agent-mode runs, which write a retrieval summary through `persistRunAsQuest` but never pass
   * the seed site in ChatCompletionProcess; and chat turns whose only retrieval write came from a
   * tool arm, which records `retrieval` with no `mode` while the seed fires only when forced
   * retrieval is on or `search_knowledge_base` was offered - reachable by offering the
   * independently-selectable `retrieve_knowledge_content` on its own. So a steady non-zero count
   * here well after the deploy is live traffic of one of the last two kinds, not stale data, and
   * it is worth telling them apart before concluding it is all agent mode.
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
 * Surfaces that run ONLY because the model asked for them - the knowledge tools.
 *
 * `attempted` alone cannot carry this question. The automatic surfaces write it too:
 * LakeMemoryFeature injects its hot-card with no `fabFileIds` guard, so on a turn where
 * KnowledgeRetrievalFeature recorded `forcedSkipReason: 'attached_files'` the merged summary is
 * `{ attempted: true, forcedSkipReason: 'attached_files' }` with nothing model-initiated in it.
 * Counting that as a choice inflates exactly the "after a forced-retrieval skip" figure the
 * routing question leans on. Keying on the surface instead of on `attempted` keeps the two apart.
 *
 * An ALLOWLIST rather than a denylist of the automatic surfaces, so an unrecognised new surface
 * under-reports the rate rather than inflating it - a metric that exists to justify building a
 * classifier must not be the one that argues for itself. A new model-initiated surface therefore
 * has to be added here; the writers are `surfaces:` in knowledgeBaseSearch / knowledgeBaseRetrieve.
 */
const MODEL_INITIATED_SURFACES: ReadonlySet<string> = new Set(['knowledgeBaseSearch', 'knowledgeBaseRetrieve']);

/**
 * Did the MODEL reach for the corpus on this turn, as opposed to a feature injecting context?
 * Requires `attempted` as well as the surface, so a summary carrying a stale surface list without
 * a run cannot count. `surfaces` is optional-chained despite being required on the schema: this
 * reads documents, and the Mongoose subdocument declares the field `required: false`.
 */
const modelRetrieved = (turn: RetrievalRateInput): boolean =>
  Boolean(turn.attempted) && Boolean(turn.surfaces?.some(surface => MODEL_INITIATED_SURFACES.has(surface)));

/**
 * The fields the fold reads. Narrower than the stored summary on purpose: it lets a caller project
 * just these out of Mongo and leave `dataLakeTags` - which lakes a turn touched - in the database
 * rather than egressing lake identity to build a counter (see the redaction CAUTION on
 * RetrievalSummarySchema). `surfaces` names retrieval MECHANISMS, not lakes, so it carries no
 * identity out with it.
 */
export type RetrievalRateInput = Pick<RetrievalSummary, 'attempted' | 'mode' | 'forcedSkipReason' | 'surfaces'>;

/**
 * The projection a caller must select for the fold to read a complete turn, derived from the input
 * type rather than hand-written: `Record<keyof RetrievalRateInput, true>` makes adding a field to
 * the type a build break here instead of a silently-unselected column that folds as `undefined`
 * and shifts every bucket. Field names only - the caller owns the path prefix.
 */
const RETRIEVAL_RATE_FIELD_SET: Record<keyof RetrievalRateInput, true> = {
  attempted: true,
  mode: true,
  forcedSkipReason: true,
  surfaces: true,
};

export const RETRIEVAL_RATE_FIELDS = Object.keys(RETRIEVAL_RATE_FIELD_SET) as (keyof RetrievalRateInput)[];

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
      if (modelRetrieved(turn)) summary.retrievedTurns += 1;
      continue;
    }

    // A forced turn that a rule suppressed still ends up on the optional path, so the numerator
    // here is the same signal as above - the model calling a knowledge tool of its own accord -
    // reached a different way. It is NOT plain `attempted`: an automatic surface can set that on
    // a suppressed turn without the model having done anything (see MODEL_INITIATED_SURFACES).
    // A forced turn with no skip reason had forced retrieval enabled and nothing switched it off;
    // see `forcedTurns` for why that is not the same as "retrieval ran".
    if (turn.forcedSkipReason) {
      summary.forcedSuppressed.turns += 1;
      summary.forcedSuppressed.byReason[turn.forcedSkipReason] += 1;
      if (modelRetrieved(turn)) summary.forcedSuppressed.retrievedTurns += 1;
      continue;
    }

    summary.forcedTurns += 1;
  }

  summary.rate = ratio(summary.retrievedTurns, summary.offeredTurns);
  summary.forcedSuppressed.rate = ratio(summary.forcedSuppressed.retrievedTurns, summary.forcedSuppressed.turns);
  return summary;
}
