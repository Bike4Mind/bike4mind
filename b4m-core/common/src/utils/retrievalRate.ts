import { FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_DEFAULT } from '../constants/forcedRetrieval';
import type { PromptMeta } from '../types/entities/PromptMetaTypes';

type RetrievalSummary = NonNullable<PromptMeta['retrieval']>;

/**
 * The `topScore` at which a replayed turn counts as answerable, pinned to the live forced-retrieval
 * absolute floor rather than being a number of its own. The question the split asks is whether
 * retrieval would have surfaced something the SYSTEM considers relevant, so the bar has to be the
 * bar production uses; a bar invented here would measure this file's opinion instead.
 *
 * Deliberately not the knowledge tool's floor, which defaults to 0 (KB_SEARCH_MIN_RELEVANCE_PCT_
 * DEFAULT) and would call every turn with any corpus at all answerable.
 *
 * Overridable per call. The replay stores the raw cosine precisely so the cutoff can be swept
 * without re-running it, which matters because this default is a setting's default, not a law -
 * an installation that has tuned forcedRetrievalMinSimilarityPct should sweep to its own value.
 */
const DEFAULT_ANSWERABLE_MIN_SCORE = FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_DEFAULT / 100;

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
   * The offered turns above, partitioned by whether the knowledge-base when-to-retrieve guidance
   * section shipped on the turn. This is the A/B readout: compare `injected.rate` against
   * `notInjected.rate`, where the second arm is produced by clearing the
   * KnowledgeBaseRetrievalPrompt setting - the section's only off switch, and one that needs no
   * deploy to throw.
   *
   * `unrecorded` is turns written before the flag existed, or by a path that never passed the
   * seed. Reported as its own arm rather than folded into either side: crediting them to one arm
   * would bias the exact comparison this exists to serve, and silently dropping them would make
   * the arms not sum. The three arms always sum to `offeredTurns`.
   *
   * A zero `notInjected.turns` does not mean the section is always on - it means nobody has run
   * the experiment. The arms describe traffic, not configuration.
   */
  guidance: {
    injected: RateArm;
    notInjected: RateArm;
    unrecorded: RateArm;
  };
  /**
   * The same offered turns, partitioned by whether the corpus in scope COULD have answered them.
   * This is the denominator the headline rate has always been missing (#1394): a turn where the
   * model did not retrieve is a defect only if there was something to find, and until this split
   * existed the two were indistinguishable.
   *
   * Read it as a 2x2 - each arm's `turns` and `retrievedTurns` give both cells:
   *
   *                    retrieved        did not retrieve
   *   answerable       correct          THE MISS  <- the number that justifies routing work
   *   notAnswerable    wasted round trip correct abstain
   *
   * `unknown` is turns the offline replay never probed, plus turns it probed inconclusively (see
   * `inconclusiveTurns`). Its own arm for the same reason `guidance.unrecorded` is: folding
   * unprobed turns into `notAnswerable` would manufacture the conclusion that there was nothing
   * to retrieve, which is precisely the claim under test. The three arms always sum to
   * `offeredTurns`.
   *
   * A large `unknown` means the replay has not been run over this window, NOT that the corpus is
   * thin. Check it before reading anything into the other two arms.
   */
  answerability: {
    /** The `topScore` at or above which a turn counts as answerable, as a cosine fraction. */
    cutoff: number;
    answerable: RateArm;
    notAnswerable: RateArm;
    unknown: RateArm;
    /**
     * Of `unknown`, the turns that WERE probed but whose scan hit its chunk ceiling below the
     * cutoff. Their true best score could be higher, so they are not negatives; counted here so a
     * big `unknown` can be told apart as "not replayed yet" versus "replayed against a corpus too
     * large to scan". The rest of `unknown` is turns with no probe at all.
     */
    inconclusiveTurns: number;
  };
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

/**
 * One arm of a partition of the offered turns - the guidance A/B, or the answerability split.
 * Same numerator throughout (the model choosing to retrieve), over the subset of offered turns in
 * that arm, so arms are directly comparable to each other and to the headline `rate`.
 */
export type RateArm = {
  turns: number;
  retrievedTurns: number;
  rate: number | null;
};

const emptyRate = (cutoff: number): OptionalPathRetrievalRate => ({
  offeredTurns: 0,
  retrievedTurns: 0,
  rate: null,
  guidance: {
    injected: { turns: 0, retrievedTurns: 0, rate: null },
    notInjected: { turns: 0, retrievedTurns: 0, rate: null },
    unrecorded: { turns: 0, retrievedTurns: 0, rate: null },
  },
  answerability: {
    cutoff,
    answerable: { turns: 0, retrievedTurns: 0, rate: null },
    notAnswerable: { turns: 0, retrievedTurns: 0, rate: null },
    unknown: { turns: 0, retrievedTurns: 0, rate: null },
    inconclusiveTurns: 0,
  },
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
 * Which answerability arm an offered turn belongs to, and the one place `scanTruncated` is
 * honoured. Mutates `summary.inconclusiveTurns` as a side effect of the truncated case rather than
 * making the caller re-derive it - the count and the arm assignment are the same decision.
 *
 * Ordering is load-bearing: the cutoff test comes BEFORE the truncation test, because a truncated
 * scan that already cleared the bar is answerable regardless. Truncation only means the true best
 * score may be HIGHER than recorded, so it can rescue a negative and can never overturn a positive.
 */
const classifyAnswerability = (
  turn: RetrievalRateInput,
  cutoff: number,
  summary: OptionalPathRetrievalRate
): RateArm => {
  const probe = turn.answerability;
  if (!probe) return summary.answerability.unknown;
  if (probe.topScore >= cutoff) return summary.answerability.answerable;
  if (probe.scanTruncated) {
    summary.answerability.inconclusiveTurns += 1;
    return summary.answerability.unknown;
  }
  return summary.answerability.notAnswerable;
};

/**
 * The fields the fold reads. Narrower than the stored summary on purpose: it lets a caller project
 * just these out of Mongo and leave `dataLakeTags` - which lakes a turn touched - in the database
 * rather than egressing lake identity to build a counter (see the redaction CAUTION on
 * RetrievalSummarySchema). `surfaces` names retrieval MECHANISMS, not lakes, so it carries no
 * identity out with it.
 */
export type RetrievalRateInput = Pick<
  RetrievalSummary,
  'attempted' | 'mode' | 'forcedSkipReason' | 'surfaces' | 'knowledgeBaseGuidanceInjected' | 'answerability'
>;

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
  knowledgeBaseGuidanceInjected: true,
  // Scalar scores and a timestamp only - no lake or file identity, so widening the projection to
  // reach it does not egress corpus identity the way `dataLakeTags` would (see the type above).
  answerability: true,
};

export const RETRIEVAL_RATE_FIELDS = Object.keys(RETRIEVAL_RATE_FIELD_SET) as (keyof RetrievalRateInput)[];

/**
 * Fold per-turn retrieval summaries into the rate. Pure: the caller owns the query, the date
 * bounding (see `mode` in RetrievalSummarySchema) and the population it hands over.
 */
export function summarizeOptionalPathRetrieval(
  turns: ReadonlyArray<RetrievalRateInput | undefined | null>,
  options: { answerableMinScore?: number } = {}
): OptionalPathRetrievalRate {
  const cutoff = options.answerableMinScore ?? DEFAULT_ANSWERABLE_MIN_SCORE;
  const summary = emptyRate(cutoff);

  for (const turn of turns) {
    if (!turn) continue;

    if (turn.mode === undefined) {
      summary.unclassifiedTurns += 1;
      continue;
    }

    if (turn.mode === 'optional') {
      summary.offeredTurns += 1;
      const retrieved = modelRetrieved(turn);
      if (retrieved) summary.retrievedTurns += 1;
      // Explicit undefined check, not truthiness: `false` is a real arm (the section was gated
      // off) and must not fall in with turns that never recorded the flag at all.
      const arm =
        turn.knowledgeBaseGuidanceInjected === undefined
          ? summary.guidance.unrecorded
          : turn.knowledgeBaseGuidanceInjected
            ? summary.guidance.injected
            : summary.guidance.notInjected;
      arm.turns += 1;
      if (retrieved) arm.retrievedTurns += 1;

      const answerabilityArm = classifyAnswerability(turn, cutoff, summary);
      answerabilityArm.turns += 1;
      if (retrieved) answerabilityArm.retrievedTurns += 1;
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
  for (const arm of [summary.guidance.injected, summary.guidance.notInjected, summary.guidance.unrecorded]) {
    arm.rate = ratio(arm.retrievedTurns, arm.turns);
  }
  for (const arm of [
    summary.answerability.answerable,
    summary.answerability.notAnswerable,
    summary.answerability.unknown,
  ]) {
    arm.rate = ratio(arm.retrievedTurns, arm.turns);
  }
  summary.forcedSuppressed.rate = ratio(summary.forcedSuppressed.retrievedTurns, summary.forcedSuppressed.turns);
  return summary;
}
