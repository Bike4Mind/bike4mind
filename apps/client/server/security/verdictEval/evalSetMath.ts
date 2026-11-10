import { createHash } from 'node:crypto';
import type { AbuseEvalExample, AbuseEvalSetItem } from '@bike4mind/database';
import {
  EVAL_COHORTS,
  VERDICT_EVAL_LABEL_SOURCES,
  type VerdictEvalLabelSource,
  type VerdictEvalWindowDays,
} from '@client/app/utils/verdictEval';
import {
  EVAL_SET_MIN_REVIEWED,
  countsTowardRecall,
  evalSetRunSchema,
  type EvalSetDetail,
  type EvalSetExample,
  type EvalSetRunReport,
} from '@client/app/utils/verdictEvalSets';
import {
  ADMIN_VERDICT_LABELS,
  ASSESSMENT_PREDICTIONS,
  CONTAINMENT_PREDICTIONS,
  SIGNUP_PREDICTIONS,
  Scoreboard,
  cohortRowsFrom,
  ratio,
  type EvalAssessment,
  type EvalDecision,
  type Label,
  type Prediction,
  type SignupChartVerdict,
} from './gradeVerdicts';

/**
 * The pure half of the evaluation sets (evalSets.ts loads and stores): campaign keys, the split,
 * the seeded sample, the Wilson bound and the run grader. Terms live in app/utils/verdictEvalSets.ts.
 */

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Connected components of `userIds` linked by the groups (members of one detection, or accounts
 * sharing a signup IP). An account in a group but outside `userIds` still joins its group's
 * components. A component's key is an opaque hash of the seed and its smallest id, so it is stable
 * for the same links and never exposes an account id.
 */
export function campaignKeys(
  seed: string,
  userIds: readonly string[],
  groups: readonly (readonly string[])[]
): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const next = parent.get(id) ?? id;
    if (next === id) {
      parent.set(id, id);
      return id;
    }
    const root = find(next);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // The smaller id stays the root, so a component's root is its smallest id.
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  };
  for (const id of userIds) find(id);
  for (const group of groups) {
    for (const id of group) find(id);
    for (let index = 1; index < group.length; index += 1) union(group[0], group[index]);
  }
  const keyOf = (root: string) => sha256Hex(`${seed}:${root}`).slice(0, 16);
  return new Map(userIds.map(id => [id, keyOf(find(id))]));
}

/** Larger groups are carrier NAT or campus networks, not campaigns. */
export const EVAL_SET_MAX_SHARED_IP_GROUP = 10;

/** Accounts grouped by signup IP: groups of two up to EVAL_SET_MAX_SHARED_IP_GROUP accounts link. */
export function sharedIpGroups(users: readonly { userId: string; ip: string | null | undefined }[]): string[][] {
  const byIp = new Map<string, string[]>();
  for (const { userId, ip } of users) {
    if (ip) byIp.set(ip, [...(byIp.get(ip) ?? []), userId]);
  }
  return [...byIp.values()].filter(group => group.length > 1 && group.length <= EVAL_SET_MAX_SHARED_IP_GROUP);
}

/** A campaign lands wholly on one split, chosen by the seed and its key. */
export function splitOf(seed: string, campaignKey: string, heldOutShare: number): 'tuning' | 'heldOut' {
  const fraction = Number.parseInt(sha256Hex(`${seed}:${campaignKey}`).slice(0, 8), 16) / 0xffffffff;
  return fraction < heldOutShare ? 'heldOut' : 'tuning';
}

/** The same ids, seed and size always give the same sample (no `$sample`). */
export function seededSample(ids: readonly string[], seed: string, size: number): string[] {
  return ids
    .map(id => ({ id, rank: sha256Hex(`${seed}:${id}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .slice(0, size)
    .map(entry => entry.id);
}

/** Lower end of the Wilson score interval for `successes` of `trials`; null with no trials. */
export function wilsonLowerBound(successes: number, trials: number, z = 1.96): number | null {
  if (trials === 0) return null;
  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  // Floored so the rounding never overstates a lower bound.
  return Math.max(0, Math.floor(((centre - margin) / (1 + z2 / trials)) * 1000) / 1000);
}

/** Time since a draw that still maps a set to the window it was drawn with. */
export const WINDOW_DRIFT_TOLERANCE_DAYS = 1;

/**
 * The smallest report window that reaches back to `since`, allowing WINDOW_DRIFT_TOLERANCE_DAYS of
 * drift since the draw (a set stores `since = drawnAt - days`); null when none does.
 */
export function windowCovering(since: Date, now: Date): VerdictEvalWindowDays | null {
  const ageDays = (now.getTime() - since.getTime()) / DAY_MS;
  return ([7, 30, 90] as const).find(days => days + WINDOW_DRIFT_TOLERANCE_DAYS >= ageDays) ?? null;
}

const isLabelSource = (source: string): source is VerdictEvalLabelSource =>
  (VERDICT_EVAL_LABEL_SOURCES as readonly string[]).includes(source);

/**
 * The example's label: its latest verdict when it has one (insufficient evidence means no label),
 * otherwise, for a flagged example, the label frozen at draw. An unflagged account carries a frozen
 * label only where an admin already acted on it, so those are no random sample and never count.
 */
export function exampleLabel(example: Pick<AbuseEvalExample, 'kind' | 'verdicts' | 'frozenLabel'>): Label | null {
  const latest = example.verdicts.at(-1);
  if (latest) {
    const label = ADMIN_VERDICT_LABELS[latest.verdict];
    return label ? { label, source: 'adminVerdict' } : null;
  }
  if (example.kind === 'flagged' && example.frozenLabel && isLabelSource(example.frozenLabel.source)) {
    return { label: example.frozenLabel.label, source: example.frozenLabel.source };
  }
  return null;
}

export type EvalSetPredictions = {
  assessments: readonly EvalAssessment[];
  decisions: readonly EvalDecision[];
  /** Absent for an account the chart did not classify; such an example abstains. */
  signupVerdicts: ReadonlyMap<string, SignupChartVerdict>;
};

/** The newest prediction per detection, then: any positive wins, all negative is negative, else abstain. */
function combine(detectionIds: readonly string[], predictionOf: (detectionId: string) => Prediction): Prediction {
  if (detectionIds.length === 0) return 'abstain';
  const predictions = detectionIds.map(predictionOf);
  if (predictions.includes('positive')) return 'positive';
  return predictions.every(prediction => prediction === 'negative') ? 'negative' : 'abstain';
}

/** Per variant (model or mode), each detection's newest prediction. */
function latestPredictions<Row extends { detectionId: string }>(
  rows: readonly Row[],
  variantOf: (row: Row) => string,
  timeOf: (row: Row) => Date,
  predictionOf: (row: Row) => Prediction
): Map<string, Map<string, Prediction>> {
  const newest = new Map<string, Map<string, Row>>();
  for (const row of rows) {
    const variant = variantOf(row);
    const byDetection = newest.get(variant) ?? new Map<string, Row>();
    const current = byDetection.get(row.detectionId);
    if (!current || timeOf(row) > timeOf(current)) byDetection.set(row.detectionId, row);
    newest.set(variant, byDetection);
  }
  return new Map(
    [...newest].map(([variant, byDetection]) => [
      variant,
      new Map([...byDetection].map(([id, row]) => [id, predictionOf(row)])),
    ])
  );
}

const round1 = (value: number) => Math.round(value * 10) / 10;

type LabelledExample = { example: AbuseEvalExample; label: Label };

/** The example's latest evaluation-set verdict as a label; null when it has none or it is inconclusive. */
export function evalSetVerdictLabel(example: Pick<AbuseEvalExample, 'verdicts'>): Label['label'] | null {
  const latest = example.verdicts.at(-1);
  return latest ? ADMIN_VERDICT_LABELS[latest.verdict] : null;
}

/**
 * Recall over the accounts created in the set window, held-out split only. Each side is its abuse
 * rate among reviewed examples times the population its examples stand for: flagged examples scale
 * by the flagged cap, unflagged ones by the sample. Both sides count only evaluation-set verdicts
 * (frozen labels are not a random sample of flagged accounts), and each needs EVAL_SET_MIN_REVIEWED.
 */
function estimateRecall(set: Pick<AbuseEvalSetItem, 'examples' | 'population' | 'window'>): EvalSetRunReport['recall'] {
  const recallExamples = set.examples.filter(example => countsTowardRecall(example, set.window));
  const reviewedLabels = (kind: AbuseEvalExample['kind']) =>
    recallExamples
      .filter(example => example.kind === kind)
      .flatMap(example => {
        const label = evalSetVerdictLabel(example);
        return label ? [label] : [];
      });

  const flaggedDrawn = set.examples.filter(example => example.kind === 'flagged').length;
  const flaggedExamples = recallExamples.filter(example => example.kind === 'flagged').length;
  const flaggedLabels = reviewedLabels('flagged');
  const flaggedAbuse = flaggedLabels.filter(label => label === 'abuse').length;
  const flaggedPopulation = flaggedDrawn === 0 ? 0 : (flaggedExamples * set.population.flagged) / flaggedDrawn;

  const unflaggedDrawn = set.examples.filter(example => example.kind === 'unflagged').length;
  const unflaggedExamples = recallExamples.filter(example => example.kind === 'unflagged').length;
  const unflaggedLabels = reviewedLabels('unflagged');
  const unflaggedAbuse = unflaggedLabels.filter(label => label === 'abuse').length;
  const unflaggedPopulation =
    unflaggedDrawn === 0 ? 0 : (set.population.unflagged * unflaggedExamples) / unflaggedDrawn;

  const estimatedFlaggedAbuse =
    flaggedLabels.length === 0 ? null : (flaggedAbuse / flaggedLabels.length) * flaggedPopulation;
  const estimatedMissedAbuse =
    unflaggedLabels.length === 0 ? null : (unflaggedAbuse / unflaggedLabels.length) * unflaggedPopulation;
  const recallWithheld =
    unflaggedLabels.length < EVAL_SET_MIN_REVIEWED
      ? ('too_few_unflagged_reviews' as const)
      : flaggedLabels.length < EVAL_SET_MIN_REVIEWED
        ? ('too_few_flagged_reviews' as const)
        : null;
  const estimatedRecall =
    recallWithheld !== null || estimatedFlaggedAbuse === null || estimatedMissedAbuse === null
      ? null
      : ratio(estimatedFlaggedAbuse, estimatedFlaggedAbuse + estimatedMissedAbuse);

  return {
    flaggedExamples,
    flaggedReviewed: flaggedLabels.length,
    flaggedAbuse,
    flaggedPopulation: Math.round(flaggedPopulation),
    unflaggedExamples,
    unflaggedReviewed: unflaggedLabels.length,
    unflaggedAbuse,
    unflaggedPopulation: Math.round(unflaggedPopulation),
    minimumReviewed: EVAL_SET_MIN_REVIEWED,
    estimatedFlaggedAbuse: estimatedFlaggedAbuse === null ? null : round1(estimatedFlaggedAbuse),
    estimatedMissedAbuse: estimatedMissedAbuse === null ? null : round1(estimatedMissedAbuse),
    estimatedRecall,
    recallWithheld,
  };
}

/**
 * Grades the automated verdicts on the held-out half of a set, against the examples' labels.
 * Unflagged examples count as negatives for the assessment and containment graders: no detection
 * means the system did not act.
 */
export function gradeEvalSet(
  set: Pick<AbuseEvalSetItem, 'examples' | 'population' | 'window'>,
  predictions: EvalSetPredictions
): EvalSetRunReport {
  const heldOut = set.examples.filter(example => example.split === 'heldOut');
  const labelled: LabelledExample[] = heldOut.flatMap(example => {
    const label = exampleLabel(example);
    return label ? [{ example, label }] : [];
  });
  const board = new Scoreboard();
  const at = (example: AbuseEvalExample) => example.signedUpAt ?? set.window.since;

  for (const { example, label } of labelled) {
    board.add({
      grader: 'detectors',
      variant: 'any',
      prediction: example.kind === 'flagged' ? 'positive' : 'negative',
      predicted: example.kind,
      label,
      detectionId: null,
      userId: example.userId,
      confidence: null,
      at: at(example),
    });
    const chartVerdict = predictions.signupVerdicts.get(example.userId);
    board.add({
      grader: 'signupVerdict',
      variant: 'chart',
      prediction: chartVerdict ? SIGNUP_PREDICTIONS[chartVerdict] : 'abstain',
      predicted: chartVerdict ?? 'unclassified',
      label,
      detectionId: null,
      userId: example.userId,
      confidence: null,
      at: at(example),
    });
  }

  const byVariant = [
    {
      grader: 'assessment' as const,
      predictions: latestPredictions(
        predictions.assessments,
        row => row.model,
        row => row.assessedAt,
        row => ASSESSMENT_PREDICTIONS[row.result]
      ),
    },
    {
      grader: 'containment' as const,
      predictions: latestPredictions(
        predictions.decisions,
        row => row.mode,
        row => row.decidedAt,
        row => CONTAINMENT_PREDICTIONS[row.outcome]
      ),
    },
  ];
  for (const { grader, predictions: perVariant } of byVariant) {
    for (const [variant, perDetection] of perVariant) {
      for (const { example, label } of labelled) {
        const prediction: Prediction =
          example.kind === 'unflagged'
            ? 'negative'
            : combine(example.detectionIds, id => perDetection.get(id) ?? 'abstain');
        board.add({
          grader,
          variant,
          prediction,
          predicted: prediction,
          label,
          detectionId: null,
          userId: example.userId,
          confidence: null,
          at: at(example),
        });
      }
    }
  }

  const labels = new Map(labelled.map(({ example, label }) => [example.userId, label]));
  const flaggedHeldOut = heldOut.filter(example => example.kind === 'flagged');
  const cohortsByUser = new Map(flaggedHeldOut.map(example => [example.userId, example.cohorts]));
  const labelSources: Record<string, number> = {};
  for (const { label } of labelled) labelSources[label.source] = (labelSources[label.source] ?? 0) + 1;

  return {
    split: 'heldOut',
    examples: heldOut.length,
    labelled: labelled.length,
    scores: board.scores().map(score => ({
      ...score,
      precisionLowerBound: wilsonLowerBound(score.truePositive, score.truePositive + score.falsePositive),
      // A flagged census next to a small unflagged sample has no meaningful rate; see estimateRecall.
      hitRate: null,
      falsePositiveRate: null,
    })),
    recall: estimateRecall(set),
    cohorts: cohortRowsFrom(cohortsByUser.keys(), labels, userId => cohortsByUser.get(userId) ?? []),
    labelSources,
  };
}

/** One example as the admin sees it: its label, latest verdict and the cohorts the report knows. */
export function toEvalSetExample(example: AbuseEvalExample): EvalSetExample {
  const label = exampleLabel(example);
  const latest = example.verdicts.at(-1) ?? null;
  return {
    userId: example.userId,
    kind: example.kind,
    split: example.split,
    detectionIds: example.detectionIds,
    campaignKey: example.campaignKey,
    cohorts: EVAL_COHORTS.filter(cohort => example.cohorts.includes(cohort)),
    signedUpAt: example.signedUpAt,
    currentLabel: label ? { label: label.label, source: latest ? 'verdict' : 'frozen' } : null,
    latestVerdict: latest,
    revision: example.revision,
  };
}

/** A stored set as the detail response: examples with their labels, and the last two runs that still parse. */
export function toEvalSetDetail(set: AbuseEvalSetItem): EvalSetDetail {
  const readable = set.runs.flatMap(run => {
    const parsed = evalSetRunSchema.safeParse(run);
    return parsed.success ? [parsed.data] : [];
  });
  const runs = readable.slice(-2);
  return {
    id: set.id,
    name: set.name,
    note: set.note,
    createdBy: set.createdBy,
    window: set.window,
    heldOutShare: set.heldOutShare,
    population: set.population,
    truncated: set.truncated,
    createdAt: set.createdAt,
    examples: set.examples.map(toEvalSetExample),
    runs,
    runCount: set.runs.length,
    unreadableRunCount: set.runs.length - readable.length,
  };
}
