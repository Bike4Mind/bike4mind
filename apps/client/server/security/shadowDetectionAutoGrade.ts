import {
  type AbuseAssessmentResult,
  type ShadowDetectionItem,
  type ShadowDetectionVerdict,
  type ShadowDetector,
} from '@bike4mind/common';
import { abuseAssessmentRepository, AdminAuditLogModel, shadowDetectionRepository, User } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import type { AdminAuditWriter } from '@bike4mind/server-utils/utils/adminAudit';
import { ACCOUNT_STATUS_ACTIONS_FILTER } from './accountStatusAuditActions';

/**
 * Grades stale signup network burst detections insufficient_evidence as automation, so the
 * Detections queue does not keep asking an admin about bursts nothing has corroborated. A detection
 * qualifies once it is `afterDays` old and still ungraded, when no account it names:
 *   - is suspended now, or was suspended or reinstated since the detection (admin audit log),
 *   - is named by a detection of any other detector,
 * and its latest judged advisory assessment is insufficient_evidence or absent. Each verdict is
 * conditional on the record still being ungraded at the revision read, so a person grading in
 * between wins. Like the suspend/reinstate auto-grade (server/admin/shadowDetectionStatusVerdicts.ts)
 * every graded record gets an audit entry; this one under a system actor.
 */

export const AUTO_GRADED_DETECTOR: ShadowDetector = 'signupNetworkBurst';
const AUTO_GRADE_VERDICT: ShadowDetectionVerdict = 'insufficient_evidence';
/** Detections considered per run; the hourly run drains a larger backlog over several runs. */
export const AUTO_GRADE_BATCH_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIME_MS = 20_000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

export type StaleDetectionGradeDeps = {
  listStale: (before: Date, limit: number) => Promise<ShadowDetectionItem[]>;
  /** Of these users, those suspended right now. */
  suspendedUserIds: (userIds: string[]) => Promise<Set<string>>;
  /** Each user's latest suspend or reinstate at or after `since`; users with none are absent. */
  latestStatusChanges: (userIds: string[], since: Date) => Promise<Map<string, Date>>;
  /** Of these users, those another detector has flagged. */
  flaggedByOtherDetectors: (userIds: string[]) => Promise<Set<string>>;
  /** The latest judged (not unknown) assessment result per detection id; unassessed ids are absent. */
  latestAssessments: (detectionIds: string[]) => Promise<Map<string, AbuseAssessmentResult>>;
  grade: (input: {
    id: string;
    expectedRevision: number;
    verdict: ShadowDetectionVerdict;
    reason: string;
  }) => Promise<ShadowDetectionItem | null>;
  writeAudit: AdminAuditWriter;
  logger: Pick<Logger, 'error'>;
};

export type StaleDetectionGradeReport = {
  considered: number;
  graded: number;
  skipped: { accountActioned: number; otherDetector: number; assessment: number; changedMeanwhile: number };
  failed: number;
};

export const autoGradeReason = (afterDays: number) =>
  `No suspension, reinstatement, other detector or conclusive assessment within ${afterDays} days`;

type SkipReason = Exclude<keyof StaleDetectionGradeReport['skipped'], 'changedMeanwhile'>;

function skipReason(
  detection: ShadowDetectionItem,
  facts: {
    suspended: Set<string>;
    statusChanges: Map<string, Date>;
    flagged: Set<string>;
    assessments: Map<string, AbuseAssessmentResult>;
  }
): SkipReason | null {
  const actioned = detection.userIds.some(userId => {
    const changedAt = facts.statusChanges.get(userId);
    return facts.suspended.has(userId) || (changedAt !== undefined && changedAt >= detection.detectedAt);
  });
  if (actioned) return 'accountActioned';
  if (detection.userIds.some(userId => facts.flagged.has(userId))) return 'otherDetector';
  const assessment = facts.assessments.get(detection.id);
  if (assessment !== undefined && assessment !== 'insufficient_evidence') return 'assessment';
  return null;
}

export async function gradeStaleSignupBursts({
  afterDays,
  now,
  deps,
  limit = AUTO_GRADE_BATCH_LIMIT,
}: {
  afterDays: number;
  now: Date;
  deps: StaleDetectionGradeDeps;
  limit?: number;
}): Promise<StaleDetectionGradeReport> {
  const report: StaleDetectionGradeReport = {
    considered: 0,
    graded: 0,
    skipped: { accountActioned: 0, otherDetector: 0, assessment: 0, changedMeanwhile: 0 },
    failed: 0,
  };
  if (!Number.isInteger(afterDays) || afterDays <= 0) return report;

  const stale = await deps.listStale(new Date(now.getTime() - afterDays * DAY_MS), limit);
  report.considered = stale.length;
  if (stale.length === 0) return report;

  const userIds = [...new Set(stale.flatMap(detection => detection.userIds))];
  const earliest = new Date(Math.min(...stale.map(detection => detection.detectedAt.getTime())));
  const [suspended, statusChanges, flagged, assessments] = await Promise.all([
    deps.suspendedUserIds(userIds),
    deps.latestStatusChanges(userIds, earliest),
    deps.flaggedByOtherDetectors(userIds),
    deps.latestAssessments(stale.map(detection => detection.id)),
  ]);

  const reason = autoGradeReason(afterDays);
  for (const detection of stale) {
    const skip = skipReason(detection, { suspended, statusChanges, flagged, assessments });
    if (skip) {
      report.skipped[skip] += 1;
      continue;
    }
    let graded: ShadowDetectionItem | null;
    try {
      graded = await deps.grade({
        id: detection.id,
        expectedRevision: detection.revision,
        verdict: AUTO_GRADE_VERDICT,
        reason,
      });
    } catch (error) {
      report.failed += 1;
      deps.logger.error(`Auto-grading shadow detection ${detection.id} failed`, error);
      continue;
    }
    if (!graded) {
      report.skipped.changedMeanwhile += 1;
      continue;
    }
    report.graded += 1;
    try {
      await deps.writeAudit({
        action: 'security.detection.reviewed',
        target: { kind: 'system', id: graded.id, displayName: `Shadow detection ${graded.id}` },
        summary: `graded a stale ${graded.detector} detection as ${AUTO_GRADE_VERDICT} by automation`,
        reason,
        details: {
          detectionId: graded.id,
          detector: graded.detector,
          policyVersion: graded.policyVersion,
          wouldAction: graded.wouldAction,
          verdict: graded.verdict,
          userIds: graded.userIds,
          source: 'automation',
        },
      });
    } catch (error) {
      deps.logger.error(`Audit entry failed for shadow detection verdict ${graded.id}`, error);
    }
  }
  return report;
}

const validObjectIds = (userIds: string[]) => userIds.filter(id => OBJECT_ID.test(id));

/** Deps reading the live collections; the audit writer and logger come from the caller. */
export const liveStaleDetectionGradeDeps = (
  deps: Pick<StaleDetectionGradeDeps, 'writeAudit' | 'logger'>
): StaleDetectionGradeDeps => ({
  ...deps,
  listStale: (before, limit) =>
    shadowDetectionRepository.listUngradedBefore({ detector: AUTO_GRADED_DETECTOR, before, limit }),
  suspendedUserIds: async userIds => {
    const ids = validObjectIds(userIds);
    if (ids.length === 0) return new Set();
    const rows = await User.find({ _id: { $in: ids }, isBanned: true }, { _id: 1 })
      .maxTimeMS(MAX_TIME_MS)
      .lean<{ _id: { toString(): string } }[]>()
      .exec();
    return new Set(rows.map(row => row._id.toString()));
  },
  latestStatusChanges: async (userIds, since) => {
    const latest = new Map<string, Date>();
    if (userIds.length === 0) return latest;
    const rows = await AdminAuditLogModel.find(
      {
        'target.kind': 'user',
        'target.id': { $in: userIds },
        occurredAt: { $gte: since },
        ...ACCOUNT_STATUS_ACTIONS_FILTER,
      },
      { 'target.id': 1, occurredAt: 1 }
    )
      .maxTimeMS(MAX_TIME_MS)
      .lean<{ target: { id: string }; occurredAt: Date }[]>()
      .exec();
    for (const { target, occurredAt } of rows) {
      const previous = latest.get(target.id);
      if (!previous || occurredAt > previous) latest.set(target.id, occurredAt);
    }
    return latest;
  },
  flaggedByOtherDetectors: userIds =>
    shadowDetectionRepository.findUsersFlaggedByOtherDetectors(userIds, AUTO_GRADED_DETECTOR),
  latestAssessments: async detectionIds =>
    new Map(
      (await abuseAssessmentRepository.findLatestJudgedForDetections(detectionIds)).map(row => [
        row.detectionId,
        row.result,
      ])
    ),
  grade: input => shadowDetectionRepository.addAutomationVerdict(input),
});
