import type {
  AbuseAssessmentResult,
  AutoContainmentOutcome,
  ShadowDetectionVerdict,
  ShadowDetectionVerdictSource,
  SignupRiskReviewState,
} from '@bike4mind/common';
import {
  AbuseAssessmentModel,
  AdminAuditLogModel,
  AutoContainmentDecisionModel,
  ShadowDetectionModel,
  UsageEvent,
  User,
  mongoose,
} from '@bike4mind/database';
import type { SignupTimeseriesRange } from '@bike4mind/server-utils/app/utils/signupSignals';
import type { VerdictEvalReport, VerdictEvalWindowDays } from '@client/app/utils/verdictEval';
import {
  ACCOUNT_STATUS_ACTIONS_FILTER,
  REINSTATED_ENTRIES,
  SUSPEND_ACTIONS,
} from '@server/security/accountStatusAuditActions';
import { signupVerdictOf } from '@bike4mind/server-utils/users/signupClassifier';
import { getSignupVerdicts } from '@bike4mind/server-utils/users/signupTimeseries';
import type { CohortSignals } from './cohorts';
import {
  gradeVerdicts,
  labelAccountsAndDetections,
  type EvalAccountOutcome,
  type EvalSpendBucket,
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
export const VERDICT_EVAL_SPEND_ACCOUNT_LIMIT = 500;
export const VERDICT_EVAL_SPEND_ROW_LIMIT = 50_000;
const SPEND_LOOKBACK_MS = 30 * DAY_MS;
const API_AGENT_SOURCES = ['api', 'agent', 'cli'];

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

export async function inChunks<T>(values: string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < values.length; start += IN_CHUNK) {
    rows.push(...(await read(values.slice(start, start + IN_CHUNK))));
  }
  return rows;
}

type LeanDetection = {
  _id: { toString(): string };
  detector: string;
  policyVersion: number;
  userIds: string[];
  detectedAt: Date;
  verdict: ShadowDetectionVerdict | null;
  verdicts?: { source?: ShadowDetectionVerdictSource }[];
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
  riskReviewAutoApproval?: unknown;
};
type LeanSignalUser = {
  _id: { toString(): string };
  signupMeta?: { userAgent?: string | null; ip?: string | null } | null;
  loginRecords?: { deviceType?: string | null }[] | null;
};

export type LoadedAccounts = {
  accounts: EvalAccountOutcome[];
  signedUpAt: Map<string, Date>;
  /** The earliest suspension or Contain by an admin, per account. */
  suspendedAt: Map<string, Date>;
  /** The signup chart verdict for accounts that signed up in the window. */
  signupVerdicts: Map<string, SignupChartVerdict>;
};

/**
 * Admin-label outcomes for the given accounts: audit-log suspensions and reinstatements, current
 * block state, review state, signup time and the signup chart verdict (for those who signed up in
 * the last `days`). Read-only; `userIds` must be valid object ids.
 */
export async function loadAccountOutcomes(
  userIds: string[],
  deps: VerdictEvalDeps = liveVerdictEvalDeps,
  now = new Date(),
  days: VerdictEvalWindowDays = 30
): Promise<LoadedAccounts> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const [audits, users] = await Promise.all([
    inChunks(userIds, chunk =>
      AdminAuditLogModel.find(
        {
          'target.kind': 'user',
          'target.id': { $in: chunk },
          ...ACCOUNT_STATUS_ACTIONS_FILTER,
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
        { createdAt: 1, isBanned: 1, 'moderation.status': 1, 'riskScore.reviewState': 1, riskReviewAutoApproval: 1 }
      )
        .maxTimeMS(MAX_TIME_MS)
        .lean<LeanUser[]>()
        .exec()
    ),
  ]);

  const times = (userId: string, actions: string[], byAdmin: boolean): number[] =>
    audits
      .filter(
        entry =>
          entry.target.id === userId &&
          actions.includes(entry.action) &&
          // A suspension the system made (auto-containment) is not an admin label.
          (!byAdmin || entry.actor.kind !== 'system')
      )
      .map(entry => entry.occurredAt.getTime());
  const latest = (userId: string, actions: string[], byAdmin: boolean): Date | null => {
    const found = times(userId, actions, byAdmin);
    return found.length > 0 ? new Date(Math.max(...found)) : null;
  };

  const signedUpAt = new Map<string, Date>();
  const suspendedAt = new Map<string, Date>();
  const accounts: EvalAccountOutcome[] = users.map(user => {
    const userId = user._id.toString();
    if (user.createdAt) signedUpAt.set(userId, user.createdAt);
    const suspensions = times(userId, SUSPEND_ACTIONS, true);
    if (suspensions.length > 0) suspendedAt.set(userId, new Date(Math.min(...suspensions)));
    return {
      userId,
      adminSuspendedAt: latest(userId, SUSPEND_ACTIONS, true),
      reinstatedAt: latest(userId, REINSTATED_ENTRIES, false),
      blockedNow: user.isBanned === true || user.moderation?.status === 'suspended',
      reviewState: user.riskScore?.reviewState ?? null,
      reviewAutoApproved: user.riskReviewAutoApproval != null,
    };
  });

  const inWindow = [...signedUpAt].filter(([, createdAt]) => createdAt >= since).map(([userId]) => userId);
  const signupVerdicts =
    inWindow.length > 0
      ? await deps.signupVerdicts({ range: RANGE_FOR_WINDOW[days], userIds: inWindow, signedUpAt, now })
      : new Map<string, SignupChartVerdict>();
  return { accounts, signedUpAt, suspendedAt, signupVerdicts };
}

/**
 * What stored signals say about each account's cohort (see cohorts.ts). Read-only. Shared signup IP
 * is another account with the same signupMeta.ip (user_signupMeta_ip); API and agent use is any
 * usage event from those sources.
 */
export async function loadCohortSignals(userIds: string[]): Promise<Map<string, CohortSignals>> {
  const users = await inChunks(userIds, chunk =>
    User.find(
      { _id: { $in: chunk.map(id => new mongoose.Types.ObjectId(id)) } },
      { 'signupMeta.userAgent': 1, 'signupMeta.ip': 1, 'loginRecords.deviceType': 1 }
    )
      .maxTimeMS(MAX_TIME_MS)
      .lean<LeanSignalUser[]>()
      .exec()
  );
  const ips = [...new Set(users.flatMap(user => (user.signupMeta?.ip ? [user.signupMeta.ip] : [])))];
  const sharedIps = new Set(
    (
      await inChunks(ips, chunk =>
        User.aggregate<{ _id: string }>([
          { $match: { 'signupMeta.ip': { $in: chunk } } },
          { $group: { _id: '$signupMeta.ip', accounts: { $sum: 1 } } },
          { $match: { accounts: { $gt: 1 } } },
        ])
          .option({ maxTimeMS: MAX_TIME_MS })
          .exec()
      )
    ).map(row => row._id)
  );
  const apiAgentUsers = new Set(
    (
      await inChunks(userIds, chunk =>
        UsageEvent.distinct('userId', { userId: { $in: chunk }, source: { $in: API_AGENT_SOURCES } })
          .maxTimeMS(MAX_TIME_MS)
          .exec()
      )
    ).map(String)
  );
  return new Map(
    users.map(user => {
      const userId = user._id.toString();
      const ip = user.signupMeta?.ip ?? null;
      return [
        userId,
        {
          userAgent: user.signupMeta?.userAgent ?? null,
          deviceTypes: (user.loginRecords ?? []).flatMap(record => (record.deviceType ? [record.deviceType] : [])),
          sharedSignupIp: ip !== null && sharedIps.has(ip),
          apiAgentUsage: apiAgentUsers.has(userId),
        },
      ];
    })
  );
}

/** Credits per account and hour bucket from `from`; `truncated` when the row cap cut the read short. */
async function loadSpend(
  userIds: string[],
  from: Date
): Promise<{ spend: Map<string, EvalSpendBucket[]>; truncated: boolean }> {
  const rows = await inChunks(userIds, chunk =>
    UsageEvent.aggregate<{ _id: { userId: string; at: Date }; credits: number }>([
      { $match: { userId: { $in: chunk }, createdAt: { $gte: from } } },
      {
        $group: {
          _id: { userId: '$userId', at: { $dateTrunc: { date: '$createdAt', unit: 'hour' } } },
          credits: { $sum: '$creditsCharged' },
        },
      },
      { $limit: VERDICT_EVAL_SPEND_ROW_LIMIT + 1 },
    ])
      .option({ maxTimeMS: MAX_TIME_MS })
      .exec()
  );
  const spend = new Map<string, EvalSpendBucket[]>();
  for (const row of rows.slice(0, VERDICT_EVAL_SPEND_ROW_LIMIT)) {
    spend.set(row._id.userId, [...(spend.get(row._id.userId) ?? []), { at: row._id.at, credits: row.credits }]);
  }
  return { spend, truncated: rows.length > VERDICT_EVAL_SPEND_ROW_LIMIT };
}

export async function loadVerdictEvalInput(
  days: VerdictEvalWindowDays,
  deps: VerdictEvalDeps = liveVerdictEvalDeps,
  now = new Date()
): Promise<GradeVerdictsInput> {
  const since = new Date(now.getTime() - days * DAY_MS);

  const fetched = await ShadowDetectionModel.find(
    { detectedAt: { $gte: since } },
    { detector: 1, policyVersion: 1, userIds: 1, detectedAt: 1, verdict: 1, verdicts: { $slice: -1 } }
  )
    .sort({ detectedAt: -1 })
    .limit(VERDICT_EVAL_DETECTION_LIMIT + 1)
    .maxTimeMS(MAX_TIME_MS)
    .lean<LeanDetection[]>()
    .exec();
  let truncated = fetched.length > VERDICT_EVAL_DETECTION_LIMIT;
  const detections = fetched.slice(0, VERDICT_EVAL_DETECTION_LIMIT).map(row => ({
    id: row._id.toString(),
    detector: row.detector,
    policyVersion: row.policyVersion,
    userIds: row.userIds,
    detectedAt: row.detectedAt,
    verdict: row.verdict ?? null,
    verdicts: row.verdicts ?? [],
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
        ...ACCOUNT_STATUS_ACTIONS_FILTER,
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

  const allUserIds = [
    ...new Set([
      ...detections.flatMap(detection => detection.userIds),
      ...actedOn.map(entry => entry.target.id),
      ...reviewed.map(user => user._id.toString()),
    ]),
  ].filter(id => OBJECT_ID.test(id));
  if (allUserIds.length > VERDICT_EVAL_ACCOUNT_LIMIT) truncated = true;
  const userIds = allUserIds.slice(0, VERDICT_EVAL_ACCOUNT_LIMIT);

  const { accounts, signedUpAt, suspendedAt, signupVerdicts } = await loadAccountOutcomes(userIds, deps, now, days);
  const detectionMembers = [...new Set(detections.flatMap(detection => detection.userIds))].filter(id =>
    OBJECT_ID.test(id)
  );
  const { detectionLabels } = labelAccountsAndDetections(detections, accounts);
  const abuseMembers = [
    ...new Set(
      detections.flatMap(detection => (detectionLabels.get(detection.id)?.label === 'abuse' ? detection.userIds : []))
    ),
  ].filter(id => OBJECT_ID.test(id));
  if (abuseMembers.length > VERDICT_EVAL_SPEND_ACCOUNT_LIMIT) truncated = true;
  const spendMembers = abuseMembers.slice(0, VERDICT_EVAL_SPEND_ACCOUNT_LIMIT);
  const spendFrom = new Date(
    Math.min(
      since.getTime() - SPEND_LOOKBACK_MS,
      ...spendMembers.flatMap(id => {
        const signedUp = signedUpAt.get(id);
        return signedUp ? [signedUp.getTime()] : [];
      })
    )
  );
  const [cohortSignals, loadedSpend] = await Promise.all([
    loadCohortSignals(detectionMembers),
    spendMembers.length > 0
      ? loadSpend(spendMembers, spendFrom)
      : { spend: new Map<string, EvalSpendBucket[]>(), truncated: false },
  ]);
  if (loadedSpend.truncated) truncated = true;

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
    spend: loadedSpend.spend,
    suspendedAt,
    cohortSignals,
    now,
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
