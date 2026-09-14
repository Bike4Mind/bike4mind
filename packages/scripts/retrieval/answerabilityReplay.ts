/**
 * The pure half of the answerability replay (#1394) - everything that decides WHAT to probe and
 * WHAT the probe says, with no Mongo, no embeddings and no network, so it can be unit-tested.
 * `answerability-replay.ts` is the runner that supplies the I/O.
 *
 * Why a replay at all: the optional-path retrieval rate cannot tell a turn where the model should
 * have searched from a turn with nothing to find, and the population that separates them is the
 * turns where retrieval never ran. Measuring those live would mean adding a brute-force chunk scan
 * to the turns that today pay nothing for retrieval, so the measurement is reconstructed after the
 * fact instead. See RetrievalSummarySchema.answerability for the drifts that follow from that.
 */

/** Structural, not the imported service types: the module stays free of the search stack. */
export type ScoredResult = { score: number };

/** The scan accounting `semanticDataLakeSearch` returns alongside its results. */
export type ScanAccounting = { truncated: boolean };

export type AnswerabilityProbe = {
  topScore: number;
  candidatesAboveFloor: number;
  floor: number;
  scanTruncated: boolean;
  probedAt: Date;
};

/** The shape the runner projects out of Mongo. Narrow on purpose - see selectReplayTargets. */
export type ReplayRow = {
  _id: string;
  prompt?: string | null;
  sessionId?: string | null;
  promptMeta?: {
    retrieval?: {
      mode?: string;
      answerability?: unknown;
    };
  };
};

export type ReplayTarget = {
  questId: string;
  prompt: string;
  sessionId: string;
};

/**
 * `no_lake_scope` is the one reason the RUNNER assigns rather than selectReplayTargets: it needs
 * the session loaded to know the turn had no lake selected, which is I/O this module does not do.
 * It is a skip and not a zero score on purpose - the knowledge tool's corpus is the session's
 * lakes PLUS the caller's own files, so a turn with no lake can still have been answerable from
 * files this replay cannot see, and scoring it as "nothing to find" would invent a negative.
 */
export type SkipReason = 'not_optional' | 'no_prompt' | 'no_session' | 'already_probed' | 'no_lake_scope';

export type ReplaySelection = {
  targets: ReplayTarget[];
  skipped: Record<SkipReason, number>;
};

const emptySkips = (): Record<SkipReason, number> => ({
  not_optional: 0,
  no_prompt: 0,
  no_session: 0,
  already_probed: 0,
  no_lake_scope: 0,
});

/**
 * Which rows this run should probe, and a tally of why the rest were passed over.
 *
 * The tally is not decoration. A run that probes 4 turns out of 5,000 is indistinguishable from a
 * broken query unless the skips are reported, and `already_probed` in particular is the difference
 * between "nothing left to do" and "the window was never covered".
 *
 * `already_probed` is skipped by default because a re-probe measures a LATER corpus against an
 * older turn, widening the content drift the field already carries. `force` exists for the case
 * where that is the point (the corpus was reindexed and the old scores are known stale), and the
 * runner is expected to say loudly that it is overwriting.
 *
 * Only `mode: 'optional'` turns are eligible: a forced turn retrieved because it was told to, so
 * its answerability says nothing about what the model would have chosen, and probing it would
 * spend a search per turn to populate a column no fold reads.
 */
export const selectReplayTargets = (
  rows: ReadonlyArray<ReplayRow>,
  options: { force?: boolean } = {}
): ReplaySelection => {
  const selection: ReplaySelection = { targets: [], skipped: emptySkips() };

  for (const row of rows) {
    const retrieval = row.promptMeta?.retrieval;
    if (retrieval?.mode !== 'optional') {
      selection.skipped.not_optional += 1;
      continue;
    }
    if (retrieval.answerability !== undefined && !options.force) {
      selection.skipped.already_probed += 1;
      continue;
    }
    // A turn with no prompt text cannot be re-scored at all - there is no query to embed. Counted
    // rather than dropped so a corpus of voice turns or empty prompts is visible as a coverage
    // hole instead of looking like a window with nothing in it.
    const prompt = row.prompt?.trim();
    if (!prompt) {
      selection.skipped.no_prompt += 1;
      continue;
    }
    if (!row.sessionId) {
      selection.skipped.no_session += 1;
      continue;
    }
    selection.targets.push({ questId: row._id, prompt, sessionId: row.sessionId });
  }

  return selection;
};

/**
 * The probe record for one replayed turn.
 *
 * `topScore` is read off the results rather than recomputed: semanticDataLakeSearch returns them
 * sorted by score descending, and taking the max here as well would only mask a future change to
 * that ordering. An empty result set scores -1 rather than 0 - a real cosine can legitimately be
 * 0 for an orthogonal chunk, so a sentinel below the valid range is what distinguishes "nothing
 * came back" from "something came back and matched nothing". The admin endpoint bounds the
 * cutoff to 0..1, so the sentinel always classifies as not-answerable there, which is what it
 * means - a direct caller of the fold could pass a negative cutoff and would not want to.
 *
 * `floor` is stored alongside `candidatesAboveFloor` because the count is meaningless without the
 * bar it was counted against, and the bar is a per-run flag.
 */
export const buildAnswerabilityProbe = (
  results: ReadonlyArray<ScoredResult>,
  scan: ScanAccounting,
  options: { floor: number; probedAt: Date }
): AnswerabilityProbe => ({
  topScore: results.length > 0 ? results[0].score : -1,
  candidatesAboveFloor: results.filter(result => result.score >= options.floor).length,
  floor: options.floor,
  scanTruncated: scan.truncated,
  probedAt: options.probedAt,
});

export type ReplayTally = {
  probed: number;
  written: number;
  failed: number;
  skipped: Record<SkipReason, number>;
};

/**
 * One block of plain text for the end of a run. Deliberately reports `probed` and `written`
 * separately: a dry run probes everything and writes nothing, and on a real run a gap between the
 * two is a write path failing quietly.
 */
export const formatReplaySummary = (tally: ReplayTally): string => {
  const skippedTotal = Object.values(tally.skipped).reduce((sum, count) => sum + count, 0);
  const lines = [
    `probed:  ${tally.probed}`,
    `written: ${tally.written}`,
    `failed:  ${tally.failed}`,
    `skipped: ${skippedTotal}`,
  ];
  for (const [reason, count] of Object.entries(tally.skipped)) {
    if (count > 0) lines.push(`  ${reason}: ${count}`);
  }
  return lines.join('\n');
};
