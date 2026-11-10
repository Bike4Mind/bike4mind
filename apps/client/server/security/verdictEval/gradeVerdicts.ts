import {
  type AbuseAssessmentResult,
  type AutoContainmentOutcome,
  isAutomationVerdict,
  type ShadowDetectionVerdict,
  type ShadowDetectionVerdictSource,
  type SignupRiskReviewState,
} from '@bike4mind/common';
import {
  EVAL_COHORTS,
  VERDICT_EVAL_LABEL_SOURCES,
  type VerdictEvalCohortRow,
  type VerdictEvalDisagreement,
  type VerdictEvalGrader,
  type VerdictEvalLabel,
  type VerdictEvalLabelSource,
  type VerdictEvalOperationsRow,
  type VerdictEvalReport,
  type VerdictEvalScore,
} from '@client/app/utils/verdictEval';
import type { SignupVerdict } from '@bike4mind/server-utils/users/signupClassifier';
import { cohortsOf, type CohortSignals } from './cohorts';

/**
 * Grades the automated abuse verdicts against admin labels. Pure; the loader
 * (loadVerdictEval.ts) supplies the rows. The report schema and its terms live in
 * app/utils/verdictEval.ts.
 *
 * Labels never come from the automation itself: an account banned only by auto-containment is
 * unlabelled until an admin confirms the detection, reinstates the account or records a review.
 */

export type EvalDetection = {
  id: string;
  detector: string;
  policyVersion: number;
  userIds: readonly string[];
  detectedAt: Date;
  verdict: ShadowDetectionVerdict | null;
  /** Only the latest entry is needed: it says whether `verdict` came from the automation grader. */
  verdicts: readonly { source?: ShadowDetectionVerdictSource }[];
};

export type EvalAssessment = {
  detectionId: string;
  result: AbuseAssessmentResult;
  confidence: number | null;
  model: string;
  assessedAt: Date;
};

export type EvalDecision = {
  detectionId: string;
  outcome: AutoContainmentOutcome;
  mode: string;
  confidence: number;
  decidedAt: Date;
};

export type EvalAccountOutcome = {
  userId: string;
  /** The latest suspension or Contain by an admin (never one made by the system). */
  adminSuspendedAt: Date | null;
  /** The latest reinstatement or containment undo, by anyone. */
  reinstatedAt: Date | null;
  /** Banned or moderated-suspended now. */
  blockedNow: boolean;
  reviewState: SignupRiskReviewState | null;
  /** The review was approved by the auto-approval policy, not by an admin. */
  reviewAutoApproved: boolean;
};

/** Credits charged to one account in one hour bucket starting at `at`. */
export type EvalSpendBucket = { at: Date; credits: number };

export type SignupChartVerdict = SignupVerdict;

export type GradeVerdictsInput = {
  since: Date;
  detections: readonly EvalDetection[];
  assessments: readonly EvalAssessment[];
  decisions: readonly EvalDecision[];
  accounts: readonly EvalAccountOutcome[];
  signupVerdicts: ReadonlyMap<string, SignupChartVerdict>;
  /** When each account signed up; the signup verdict's disagreements are dated by it. */
  signedUpAt: ReadonlyMap<string, Date>;
  /** Credits per account for the members of detections labelled abuse. */
  spend: ReadonlyMap<string, readonly EvalSpendBucket[]>;
  /** The earliest suspension or Contain by an admin, per account. */
  suspendedAt: ReadonlyMap<string, Date>;
  cohortSignals: ReadonlyMap<string, CohortSignals>;
  now: Date;
  truncated: boolean;
};

export type Label = { label: VerdictEvalLabel; source: VerdictEvalLabelSource };
export type Prediction = 'positive' | 'negative' | 'abstain';

export const MAX_DISAGREEMENTS = 100;

export const ADMIN_VERDICT_LABELS: Record<ShadowDetectionVerdict, VerdictEvalLabel | null> = {
  confirmed_abuse: 'abuse',
  legitimate_human: 'legit',
  legitimate_automation: 'legit',
  insufficient_evidence: null,
};

export const ASSESSMENT_PREDICTIONS: Record<AbuseAssessmentResult, Prediction> = {
  abuse: 'positive',
  legitimate_automation: 'negative',
  insufficient_evidence: 'abstain',
  unknown: 'abstain',
};

export const CONTAINMENT_PREDICTIONS: Record<AutoContainmentOutcome, Prediction> = {
  would_contain: 'positive',
  contained: 'positive',
  // Capped means it would have contained but the hourly cap held it back.
  capped: 'positive',
  withdrawn: 'negative',
  pending: 'abstain',
  failed: 'abstain',
};

export const SIGNUP_PREDICTIONS: Record<SignupChartVerdict, Prediction> = {
  suspected: 'positive',
  legit: 'negative',
  unclassified: 'abstain',
};

export function accountLabel(outcome: EvalAccountOutcome): Label | null {
  const { adminSuspendedAt, reinstatedAt } = outcome;
  if (reinstatedAt && (!adminSuspendedAt || reinstatedAt >= adminSuspendedAt)) {
    return { label: 'legit', source: 'reinstated' };
  }
  if (adminSuspendedAt && outcome.blockedNow) return { label: 'abuse', source: 'adminSuspended' };
  if (outcome.reviewState === 'banned') return { label: 'abuse', source: 'riskReview' };
  // An approval by the auto-approval policy is the system's call, not an admin's.
  if (outcome.reviewState === 'approved' && !outcome.reviewAutoApproved)
    return { label: 'legit', source: 'riskReview' };
  return null;
}

const strongest = (labels: Label[]): Label =>
  labels.reduce((best, next) =>
    VERDICT_EVAL_LABEL_SOURCES.indexOf(next.source) < VERDICT_EVAL_LABEL_SOURCES.indexOf(best.source) ? next : best
  );

/**
 * The admin verdict when there is one (insufficient evidence leaves it unlabelled); otherwise the
 * members' labels when every labelled member agrees. An automation verdict is not an admin one.
 */
export function detectionLabel(detection: EvalDetection, accountLabels: ReadonlyMap<string, Label>): Label | null {
  if (detection.verdict && !isAutomationVerdict(detection)) {
    const label = ADMIN_VERDICT_LABELS[detection.verdict];
    return label ? { label, source: 'adminVerdict' } : null;
  }
  const memberLabels = detection.userIds.flatMap(id => {
    const label = accountLabels.get(id);
    return label ? [label] : [];
  });
  if (memberLabels.length === 0) return null;
  if (new Set(memberLabels.map(label => label.label)).size > 1) return null;
  return strongest(memberLabels);
}

type Tally = Omit<VerdictEvalScore, 'precision' | 'hitRate' | 'falsePositiveRate'>;

export const ratio = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 1000);

export class Scoreboard {
  private readonly tallies = new Map<string, Tally>();
  readonly disagreements: VerdictEvalDisagreement[] = [];

  add(entry: {
    grader: VerdictEvalGrader;
    variant: string;
    prediction: Prediction;
    predicted: string;
    label: Label;
    detectionId: string | null;
    userId: string | null;
    confidence: number | null;
    at: Date;
  }) {
    const key = `${entry.grader}\u0000${entry.variant}`;
    const tally = this.tallies.get(key) ?? {
      grader: entry.grader,
      variant: entry.variant,
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 0,
      trueNegative: 0,
      abstained: 0,
    };
    this.tallies.set(key, tally);
    if (entry.prediction === 'abstain') {
      tally.abstained += 1;
      return;
    }
    const abuse = entry.label.label === 'abuse';
    const positive = entry.prediction === 'positive';
    if (positive && abuse) tally.truePositive += 1;
    else if (!positive && !abuse) tally.trueNegative += 1;
    else {
      if (positive) tally.falsePositive += 1;
      else tally.falseNegative += 1;
      this.disagreements.push({
        grader: entry.grader,
        variant: entry.variant,
        kind: positive ? 'falsePositive' : 'falseNegative',
        detectionId: entry.detectionId,
        userId: entry.userId,
        predicted: entry.predicted,
        label: entry.label.label,
        labelSource: entry.label.source,
        confidence: entry.confidence,
        at: entry.at,
      });
    }
  }

  scores(): VerdictEvalScore[] {
    return [...this.tallies.values()]
      .map(tally => ({
        ...tally,
        precision: ratio(tally.truePositive, tally.truePositive + tally.falsePositive),
        hitRate: ratio(tally.truePositive, tally.truePositive + tally.falseNegative),
        falsePositiveRate: ratio(tally.falsePositive, tally.falsePositive + tally.trueNegative),
      }))
      .sort((a, b) => a.grader.localeCompare(b.grader) || a.variant.localeCompare(b.variant));
  }
}

/** The newest row per key. */
function latestBy<T>(rows: readonly T[], keyOf: (row: T) => string, timeOf: (row: T) => Date): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const current = latest.get(keyOf(row));
    if (!current || timeOf(row) > timeOf(current)) latest.set(keyOf(row), row);
  }
  return [...latest.values()];
}

/**
 * Account labels, detection labels, and account labels with the admin verdict on a detection
 * inherited by its members (an account's own label first).
 */
export function labelAccountsAndDetections(
  detections: readonly EvalDetection[],
  accounts: readonly EvalAccountOutcome[]
) {
  const accountLabels = new Map<string, Label>();
  for (const outcome of accounts) {
    const label = accountLabel(outcome);
    if (label) accountLabels.set(outcome.userId, label);
  }
  const detectionLabels = new Map<string, Label>();
  for (const detection of detections) {
    const label = detectionLabel(detection, accountLabels);
    if (label) detectionLabels.set(detection.id, label);
  }
  const signupLabels = new Map(accountLabels);
  for (const detection of detections) {
    const label = detectionLabels.get(detection.id);
    if (label?.source !== 'adminVerdict') continue;
    for (const userId of detection.userIds) if (!signupLabels.has(userId)) signupLabels.set(userId, label);
  }
  return { accountLabels, detectionLabels, signupLabels };
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const HOUR_MS = 60 * 60 * 1000;

/** Nearest-rank percentile of an ascending list. */
const percentile = (sorted: readonly number[], fraction: number) =>
  sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function operationsRows(
  input: GradeVerdictsInput,
  detectionLabels: ReadonlyMap<string, Label>
): VerdictEvalOperationsRow[] {
  const byDetector = new Map<string, EvalDetection[]>();
  for (const detection of input.detections) {
    byDetector.set(detection.detector, [...(byDetector.get(detection.detector) ?? []), detection]);
  }
  return [...byDetector]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([detector, detections]) => {
      const reviewed = detections.filter(detection => detection.verdict !== null);
      const conclusive = reviewed.filter(detection => detection.verdict !== 'insufficient_evidence');
      const confirmed = conclusive.filter(detection => detection.verdict === 'confirmed_abuse');
      const abuseDetections = detections.filter(detection => detectionLabels.get(detection.id)?.label === 'abuse');

      const hours: number[] = [];
      let accounts = 0;
      let creditsBefore = 0;
      let creditsAfter = 0;
      for (const detection of abuseDetections) {
        const signups = detection.userIds.flatMap(id => {
          const signedUp = input.signedUpAt.get(id);
          return signedUp ? [signedUp.getTime()] : [];
        });
        if (signups.length > 0) {
          const elapsed = detection.detectedAt.getTime() - Math.min(...signups);
          if (elapsed >= 0) hours.push(elapsed / HOUR_MS);
        }
        for (const userId of detection.userIds) {
          accounts += 1;
          const signedUp = input.signedUpAt.get(userId);
          const end = input.suspendedAt.get(userId) ?? input.now;
          for (const bucket of input.spend.get(userId) ?? []) {
            if (signedUp && bucket.at < signedUp) continue;
            // Buckets are an hour wide: one straddling the detection counts by its start.
            if (bucket.at < detection.detectedAt) creditsBefore += bucket.credits;
            else if (bucket.at < end) creditsAfter += bucket.credits;
          }
        }
      }
      const sortedHours = hours.sort((a, b) => a - b);
      return {
        detector,
        detections: detections.length,
        reviewed: reviewed.length,
        conclusive: conclusive.length,
        reviewYield: ratio(confirmed.length, conclusive.length),
        timeToDetection:
          sortedHours.length > 0
            ? {
                n: sortedHours.length,
                medianHours: round1(median(sortedHours)),
                p90Hours: round1(percentile(sortedHours, 0.9)),
              }
            : null,
        spend:
          abuseDetections.length > 0
            ? {
                accounts,
                creditsBeforeDetection: Math.round(creditsBefore * 100) / 100,
                creditsAfterDetection: Math.round(creditsAfter * 100) / 100,
              }
            : null,
      };
    });
}

/**
 * One row per cohort over `userIds`, counting the accounts in each cohort and how admins labelled them.
 * Accounts with no loaded signals belong to no cohort.
 */
export function cohortRows(
  userIds: Iterable<string>,
  labels: ReadonlyMap<string, Label>,
  signals: ReadonlyMap<string, CohortSignals>
): VerdictEvalCohortRow[] {
  return cohortRowsFrom(userIds, labels, userId => {
    const accountSignals = signals.get(userId);
    return accountSignals ? cohortsOf(accountSignals) : [];
  });
}

/** `cohortRows` for callers that already hold each account's cohorts. */
export function cohortRowsFrom(
  userIds: Iterable<string>,
  labels: ReadonlyMap<string, Label>,
  cohortsFor: (userId: string) => readonly string[]
): VerdictEvalCohortRow[] {
  const rows = EVAL_COHORTS.map(cohort => ({
    cohort,
    measurable: cohort !== 'assistive',
    flaggedAccounts: 0,
    labelledAccounts: 0,
    abuse: 0,
    legit: 0,
    falsePositiveShare: null as number | null,
  }));
  for (const userId of new Set(userIds)) {
    const label = labels.get(userId);
    for (const cohort of cohortsFor(userId)) {
      const row = rows.find(candidate => candidate.cohort === cohort);
      if (!row) continue;
      row.flaggedAccounts += 1;
      if (!label) continue;
      row.labelledAccounts += 1;
      if (label.label === 'abuse') row.abuse += 1;
      else row.legit += 1;
    }
  }
  return rows.map(row => ({ ...row, falsePositiveShare: ratio(row.legit, row.labelledAccounts) }));
}

export function gradeVerdicts(input: GradeVerdictsInput): VerdictEvalReport {
  const { accountLabels, detectionLabels, signupLabels } = labelAccountsAndDetections(input.detections, input.accounts);

  const board = new Scoreboard();
  for (const assessment of latestBy(
    input.assessments,
    row => `${row.detectionId}:${row.model}`,
    row => row.assessedAt
  )) {
    const label = detectionLabels.get(assessment.detectionId);
    if (!label) continue;
    board.add({
      grader: 'assessment',
      variant: assessment.model,
      prediction: ASSESSMENT_PREDICTIONS[assessment.result],
      predicted: assessment.result,
      label,
      detectionId: assessment.detectionId,
      userId: null,
      confidence: assessment.confidence,
      at: assessment.assessedAt,
    });
  }
  for (const decision of latestBy(
    input.decisions,
    row => `${row.detectionId}:${row.mode}`,
    row => row.decidedAt
  )) {
    const label = detectionLabels.get(decision.detectionId);
    if (!label) continue;
    board.add({
      grader: 'containment',
      variant: decision.mode,
      prediction: CONTAINMENT_PREDICTIONS[decision.outcome],
      predicted: decision.outcome,
      label,
      detectionId: decision.detectionId,
      userId: null,
      confidence: decision.confidence,
      at: decision.decidedAt,
    });
  }

  for (const [userId, label] of signupLabels) {
    const verdict = input.signupVerdicts.get(userId);
    if (!verdict) continue;
    board.add({
      grader: 'signupVerdict',
      variant: 'chart',
      prediction: SIGNUP_PREDICTIONS[verdict],
      predicted: verdict,
      label,
      detectionId: null,
      userId,
      confidence: null,
      at: input.signedUpAt.get(userId) ?? input.since,
    });
  }

  return {
    since: input.since,
    detections: input.detections.length,
    labelledDetections: detectionLabels.size,
    labelledAccounts: signupLabels.size,
    excludedAutoApprovals: input.accounts.filter(
      outcome => outcome.reviewState === 'approved' && outcome.reviewAutoApproved && !accountLabels.has(outcome.userId)
    ).length,
    scores: board.scores(),
    operations: operationsRows(input, detectionLabels),
    cohorts: cohortRows(
      input.detections.flatMap(detection => detection.userIds),
      signupLabels,
      input.cohortSignals
    ),
    disagreements: board.disagreements.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, MAX_DISAGREEMENTS),
    truncated: input.truncated,
  };
}
