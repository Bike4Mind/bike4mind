import type {
  AbuseAssessmentResult,
  AutoContainmentOutcome,
  ShadowDetectionVerdict,
  SignupRiskReviewState,
} from '@bike4mind/common';
import {
  AbuseAssessmentModel,
  AdminAuditLogModel,
  AutoContainmentDecisionModel,
  ShadowDetectionModel,
  User,
  mongoose,
} from '@bike4mind/database';
import type { SignupTimeseriesRange } from '@client/app/utils/signupSignals';
import type { VerdictEvalReport, VerdictEvalWindowDays } from '@client/app/utils/verdictEval';
import { signupVerdictOf } from '@server/users/signupClassifier';
import { getSignupVerdicts } from '@server/users/signupTimeseries';
import {
  gradeVerdicts,
  type EvalAccountOutcome,
  type GradeVerdictsInput,
  type SignupChartVerdict,
} from './gradeVerdicts';

/**
 * Loads the rows the verdict eval grades (gradeVerdicts.ts) for detections and labelled accounts in
 * the window. Read-only. Every read is capped and served by an existing index: detections by
 * detectedAt, assessments and decisions by detectionId, audit entries by action + occurredAt and by
 * target, users by _id and createdAt.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIME_MS = 20_000;
export const VERDICT_EVAL_DETECTION_LIMIT = 2_000;
export const VERDICT_EVAL_ACCOUNT_LIMIT = 5_000;
const IN_CHUNK = 500;

const SUSPEND_ACTIONS = ['user.suspended', 'user.bulk.contained'];
const REINSTATE_ACTIONS = ['user.reinstated', 'user.bulk.undone'];
const LABEL_REVIEW_STATES: SignupRiskReviewState[] = ['approved', 'banned'];
const OBJECT_ID = /^[0-9a-f]{24}$/;

const RANGE_FOR_WINDOW: Record<VerdictEvalWindowDays, SignupTimeseriesRange> = { 7: '7d', 30: '30d', 90: '90d' };

export type VerdictEvalDeps = {
  /** The signup chart verdict for each id it classifies; others are absent. */
  signupVerdicts: (input: {
    range: SignupTimeseriesRange;
    userIds: string[];
    signedUpAt: ReadonlyMap<string, Date>;
    now: Date;
  }) => Promise<Map<string, SignupChartVerdict>>;
};

export const liveVerdictEvalDeps: VerdictEvalDeps = {
  signupVerdicts: async ({ range, userIds, signedUpAt, now }) => {
    const { verdicts } = await getSignupVerdicts({ range, userIds }, now);
    const result = new Map<string, SignupChartVerdict>();
    for (const [userId, verdict] of Object.entries(verdicts)) {
      const createdAt = signedUpAt.get(userId);
      if (verdict && createdAt) result.set(userId, signupVerdictOf(verdict.signals, createdAt, now));
    }
    return result;
  },
};

async function inChunks<T>(values: string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < values.length; start += IN_CHUNK) {
    rows.push(...(await read(values.slice(start, start + IN_CHUNK))));
  }
  return rows;
}

type LeanDetection = {
  _id: { toString(): string };
  userIds: string[];
  detectedAt: Date;
  verdict: ShadowDetectionVerdict | null;
};
type LeanAssessment = {
  detectionId: string;
  result: AbuseAssessmentResult;
  confidence: number | null;
  decisionModel: string;
  assessedAt: Date;
};
type LeanDecision = {
  detectionId: string;
  outcome: AutoContainmentOutcome;
  mode: string;
  confidence: number;
  decidedAt: Date;
};
type LeanAudit = { action: string; actor: { kind: string }; target: { id: string }; occurredAt: Date };
type LeanUser = {
  _id: { toString(): string };
  createdAt?: Date | null;
  isBanned?: boolean;
  moderation?: { status?: string } | null;
  riskScore?: { reviewState?: SignupRiskReviewState } | null;
};

export async function loadVerdictEvalInput(
  days: VerdictEvalWindowDays,
  deps: VerdictEvalDeps = liveVerdictEvalDeps,
  now = new Date()
): Promise<GradeVerdictsInput> {
  const since = new Date(now.getTime() - days * DAY_MS);

  const fetched = await ShadowDetectionModel.find(
    { detectedAt: { $gte: since } },
    { userIds: 1, detectedAt: 1, verdict: 1 }
  )
    .sort({ detectedAt: -1 })
    .limit(VERDICT_EVAL_DETECTION_LIMIT + 1)
    .maxTimeMS(MAX_TIME_MS)
    .lean<LeanDetection[]>()
    .exec();
  let truncated = fetched.length > VERDICT_EVAL_DETECTION_LIMIT;
  const detections = fetched.slice(0, VERDICT_EVAL_DETECTION_LIMIT).map(row => ({
    id: row._id.toString(),
    userIds: row.userIds,
    detectedAt: row.detectedAt,
    verdict: row.verdict ?? null,
  }));
  const detectionIds = detections.map(detection => detection.id);

  const [assessments, decisions, actedOn, reviewed] = await Promise.all([
    inChunks(detectionIds, chunk =>
      AbuseAssessmentModel.find(
        { detectionId: { $in: chunk } },
        { detectionId: 1, result: 1, confidence: 1, decisionModel: 1, assessedAt: 1 }
      )
        .maxTimeMS(MAX_TIME_MS)
        .lean<LeanAssessment[]>()
        .exec()
    ),
    inChunks(detectionIds, chunk =>
      AutoContainmentDecisionModel.find(
        { detectionId: { $in: chunk } },
        { detectionId: 1, outcome: 1, mode: 1, confidence: 1, decidedAt: 1 }
      )
        .maxTimeMS(MAX_TIME_MS)
        .lean<LeanDecision[]>()
        .exec()
    ),
    // Accounts an admin suspended, contained, reinstated or un-contained in the window, with or without a detection.
    AdminAuditLogModel.find(
      {
        action: { $in: [...SUSPEND_ACTIONS, ...REINSTATE_ACTIONS] },
        occurredAt: { $gte: since },
        'target.kind': 'user',
      },
      { 'target.id': 1 }
    )
      .limit(VERDICT_EVAL_ACCOUNT_LIMIT + 1)
      .maxTimeMS(MAX_TIME_MS)
      .lean<Pick<LeanAudit, 'target'>[]>()
      .exec(),
    // Signups in the window whose risk review an admin closed.
    User.find({ createdAt: { $gte: since }, 'riskScore.reviewState': { $in: LABEL_REVIEW_STATES } }, { _id: 1 })
      .limit(VERDICT_EVAL_ACCOUNT_LIMIT + 1)
      .maxTimeMS(MAX_TIME_MS)
      .lean<{ _id: { toString(): string } }[]>()
      .exec(),
  ]);
  if (actedOn.length > VERDICT_EVAL_ACCOUNT_LIMIT || reviewed.length > VERDICT_EVAL_ACCOUNT_LIMIT) truncated = true;

  const userIds = [
    ...new Set([
      ...detections.flatMap(detection => detection.userIds),
      ...actedOn.map(entry => entry.target.id),
      ...reviewed.map(user => user._id.toString()),
    ]),
  ]
    .filter(id => OBJECT_ID.test(id))
    .slice(0, VERDICT_EVAL_ACCOUNT_LIMIT);

  const [audits, users] = await Promise.all([
    inChunks(userIds, chunk =>
      AdminAuditLogModel.find(
        {
          'target.kind': 'user',
          'target.id': { $in: chunk },
          action: { $in: [...SUSPEND_ACTIONS, ...REINSTATE_ACTIONS] },
        },
        { action: 1, 'actor.kind': 1, 'target.id': 1, occurredAt: 1 }
      )
        .maxTimeMS(MAX_TIME_MS)
        .lean<LeanAudit[]>()
        .exec()
    ),
    inChunks(userIds, chunk =>
      User.find(
        { _id: { $in: chunk.map(id => new mongoose.Types.ObjectId(id)) } },
        { createdAt: 1, isBanned: 1, 'moderation.status': 1, 'riskScore.reviewState': 1 }
      )
        .maxTimeMS(MAX_TIME_MS)
        .lean<LeanUser[]>()
        .exec()
    ),
  ]);

  const latest = (userId: string, actions: string[], byAdmin: boolean): Date | null => {
    const times = audits
      .filter(
        entry =>
          entry.target.id === userId &&
          actions.includes(entry.action) &&
          // A suspension the system made (auto-containment) is not an admin label.
          (!byAdmin || entry.actor.kind !== 'system')
      )
      .map(entry => entry.occurredAt.getTime());
    return times.length > 0 ? new Date(Math.max(...times)) : null;
  };

  const signedUpAt = new Map<string, Date>();
  const accounts: EvalAccountOutcome[] = users.map(user => {
    const userId = user._id.toString();
    if (user.createdAt) signedUpAt.set(userId, user.createdAt);
    return {
      userId,
      adminSuspendedAt: latest(userId, SUSPEND_ACTIONS, true),
      reinstatedAt: latest(userId, REINSTATE_ACTIONS, false),
      blockedNow: user.isBanned === true || user.moderation?.status === 'suspended',
      reviewState: user.riskScore?.reviewState ?? null,
    };
  });

  const inWindow = [...signedUpAt].filter(([, createdAt]) => createdAt >= since).map(([userId]) => userId);
  const signupVerdicts =
    inWindow.length > 0
      ? await deps.signupVerdicts({ range: RANGE_FOR_WINDOW[days], userIds: inWindow, signedUpAt, now })
      : new Map<string, SignupChartVerdict>();

  return {
    since,
    detections,
    assessments: assessments.map(row => ({
      detectionId: row.detectionId,
      result: row.result,
      confidence: row.confidence ?? null,
      model: row.decisionModel,
      assessedAt: row.assessedAt,
    })),
    decisions,
    accounts,
    signupVerdicts,
    signedUpAt,
    truncated,
  };
}

export async function buildVerdictEvalReport(
  days: VerdictEvalWindowDays,
  deps: VerdictEvalDeps = liveVerdictEvalDeps,
  now = new Date()
): Promise<VerdictEvalReport> {
  return gradeVerdicts(await loadVerdictEvalInput(days, deps, now));
}
