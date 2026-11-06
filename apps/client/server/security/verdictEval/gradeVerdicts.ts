import type {
  AbuseAssessmentResult,
  AutoContainmentOutcome,
  ShadowDetectionVerdict,
  SignupRiskReviewState,
} from '@bike4mind/common';
import {
  VERDICT_EVAL_LABEL_SOURCES,
  type VerdictEvalDisagreement,
  type VerdictEvalGrader,
  type VerdictEvalLabel,
  type VerdictEvalLabelSource,
  type VerdictEvalReport,
  type VerdictEvalScore,
} from '@client/app/utils/verdictEval';

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
  userIds: readonly string[];
  detectedAt: Date;
  verdict: ShadowDetectionVerdict | null;
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
};

export type SignupChartVerdict = 'suspected' | 'legit' | 'unclassified';

export type GradeVerdictsInput = {
  since: Date;
  detections: readonly EvalDetection[];
  assessments: readonly EvalAssessment[];
  decisions: readonly EvalDecision[];
  accounts: readonly EvalAccountOutcome[];
  signupVerdicts: ReadonlyMap<string, SignupChartVerdict>;
  /** When each account signed up; the signup verdict's disagreements are dated by it. */
  signedUpAt: ReadonlyMap<string, Date>;
  truncated: boolean;
};

type Label = { label: VerdictEvalLabel; source: VerdictEvalLabelSource };
type Prediction = 'positive' | 'negative' | 'abstain';

export const MAX_DISAGREEMENTS = 100;

const ADMIN_VERDICT_LABELS: Record<ShadowDetectionVerdict, VerdictEvalLabel | null> = {
  confirmed_abuse: 'abuse',
  legitimate_human: 'legit',
  legitimate_automation: 'legit',
  insufficient_evidence: null,
};

const ASSESSMENT_PREDICTIONS: Record<AbuseAssessmentResult, Prediction> = {
  abuse: 'positive',
  legitimate_automation: 'negative',
  insufficient_evidence: 'abstain',
  unknown: 'abstain',
};

const CONTAINMENT_PREDICTIONS: Record<AutoContainmentOutcome, Prediction> = {
  would_contain: 'positive',
  contained: 'positive',
  // Capped means it would have contained but the hourly cap held it back.
  capped: 'positive',
  withdrawn: 'negative',
  pending: 'abstain',
  failed: 'abstain',
};

const SIGNUP_PREDICTIONS: Record<SignupChartVerdict, Prediction> = {
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
  if (outcome.reviewState === 'approved') return { label: 'legit', source: 'riskReview' };
  return null;
}

const strongest = (labels: Label[]): Label =>
  labels.reduce((best, next) =>
    VERDICT_EVAL_LABEL_SOURCES.indexOf(next.source) < VERDICT_EVAL_LABEL_SOURCES.indexOf(best.source) ? next : best
  );

/**
 * The admin verdict when there is one (insufficient evidence leaves it unlabelled); otherwise the
 * members' labels when every labelled member agrees.
 */
export function detectionLabel(detection: EvalDetection, accountLabels: ReadonlyMap<string, Label>): Label | null {
  if (detection.verdict) {
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

const ratio = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 1000);

class Scoreboard {
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

export function gradeVerdicts(input: GradeVerdictsInput): VerdictEvalReport {
  const accountLabels = new Map<string, Label>();
  for (const outcome of input.accounts) {
    const label = accountLabel(outcome);
    if (label) accountLabels.set(outcome.userId, label);
  }
  const detectionLabels = new Map<string, Label>();
  for (const detection of input.detections) {
    const label = detectionLabel(detection, accountLabels);
    if (label) detectionLabels.set(detection.id, label);
  }

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

  // An account's own label first; a member of a detection an admin ruled on inherits that ruling.
  const signupLabels = new Map(accountLabels);
  for (const detection of input.detections) {
    const label = detectionLabels.get(detection.id);
    if (label?.source !== 'adminVerdict') continue;
    for (const userId of detection.userIds) if (!signupLabels.has(userId)) signupLabels.set(userId, label);
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
    scores: board.scores(),
    disagreements: board.disagreements.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, MAX_DISAGREEMENTS),
    truncated: input.truncated,
  };
}
