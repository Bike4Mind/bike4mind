import {
  AutoContainmentConfigSchema,
  type AbuseAssessmentItem,
  type AutoContainmentConfig,
  type AutoContainmentDecisionItem,
  type ShadowDetectionItem,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  autoContainmentDecisionRepository,
  cacheRepository,
  shadowDetectionRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import type { AdminUsersBulkResult } from '@client/app/utils/adminUsersBulk';
import { usersBulkExecuteDepsFor, usersBulkResolveDeps } from '@server/admin/usersBulk/adapters';
import { executeAdminUsersBulk } from '@server/admin/usersBulk/execute';
import { cohortHashOf, resolveAdminUsersBulk } from '@server/admin/usersBulk/resolve';
import { systemAuditWriter } from '@server/utils/systemAuditWriter';
import { decideContainment, type AutoContainmentSkipReason } from './policy';

/**
 * Automated containment: turns an `abuse` judgment on a shadow detection into the admin bulk Contain
 * (suspend, positive balance removed, API keys revoked, realtime sessions ended, optionally owned
 * email domains blocked), attributed to a system actor with the evidence as the audit reason.
 *
 * - autoContainmentConfig.mode gates it: off does nothing, shadow (the default) records the decision
 *   and changes no account, enforce contains.
 * - One decision per detection (the AutoContainmentDecision unique index), so a re-sweep or a cached
 *   judgment never acts twice; an admin verdict on the detection always wins.
 * - A fixed one-hour window caps decisions in both modes; over it, the decision is recorded `capped`
 *   for an admin. Shadow grading reads these records against the detections' admin verdicts.
 * - Reversal is the user profile's Unsuspend; keys stay revoked (the user mints new ones), as after
 *   any suspension.
 */

const HOUR_MS = 60 * 60 * 1000;
const HOURLY_KEY = 'autoContainment:decisions';
export const AUTO_CONTAINMENT_ACTOR = 'auto-containment';
// Stands in for the admin id the bulk path records (revokedBy, ledger metadata, undo record).
export const AUTO_CONTAINMENT_ACTOR_ID = `system:${AUTO_CONTAINMENT_ACTOR}`;
const AUDIT_ROUTE = 'security/autoContainment';

export type ContainRequest = {
  userIds: string[];
  reason: string;
  /** Replaying the same key returns the first result instead of acting again. */
  idempotencyKey: string;
  blockEmailDomains: boolean;
};

export type AutoContainmentDeps = {
  loadConfig: () => Promise<AutoContainmentConfig>;
  findDetection: (id: string) => Promise<ShadowDetectionItem | null>;
  decisions: Pick<typeof autoContainmentDecisionRepository, 'findByDetectionId' | 'recordOnce' | 'finish'>;
  /** Takes one decision from the hourly window; false when it is spent. */
  takeHourlySlot: (maxPerHour: number) => Promise<boolean>;
  contain: (request: ContainRequest) => Promise<AdminUsersBulkResult | null>;
  now: () => Date;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
};

export type AutoContainmentRunResult =
  | { status: 'skipped'; reason: AutoContainmentSkipReason | 'detection_not_found' | 'already_decided' }
  | { status: 'decided'; decision: AutoContainmentDecisionItem };

export const loadAutoContainmentConfig = async (): Promise<AutoContainmentConfig> => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['autoContainmentConfig'], skipCache: true }
  );
  return getSettingsValue('autoContainmentConfig', settings, AutoContainmentConfigSchema.parse({}));
};

/** The Contain path with a system actor; null when no account on the request is eligible (admins never are). */
export const containAsSystem =
  (logger?: Logger) =>
  async (request: ContainRequest): Promise<AdminUsersBulkResult | null> => {
    const now = new Date();
    const target = { kind: 'ids' as const, userIds: request.userIds };
    const cohort = await resolveAdminUsersBulk(target, [], usersBulkResolveDeps, now);
    if (cohort.eligible.length === 0) return null;
    return executeAdminUsersBulk(
      {
        target,
        action: { type: 'contain', blockEmailDomains: request.blockEmailDomains },
        reason: request.reason,
        idempotencyKey: request.idempotencyKey,
        expectedCount: cohort.eligible.length,
        cohortHash: cohortHashOf(cohort.eligible),
      },
      { id: AUTO_CONTAINMENT_ACTOR_ID, selfIds: [] },
      usersBulkExecuteDepsFor(systemAuditWriter(AUTO_CONTAINMENT_ACTOR, AUDIT_ROUTE, logger), request.reason, logger)
    );
  };

export const liveAutoContainmentDeps = (logger: Logger): AutoContainmentDeps => ({
  loadConfig: loadAutoContainmentConfig,
  findDetection: id => shadowDetectionRepository.findById(id),
  decisions: autoContainmentDecisionRepository,
  takeHourlySlot: async maxPerHour =>
    maxPerHour > 0 &&
    (await cacheRepository.tryIncrementWithinLimitFixedWindow(HOURLY_KEY, maxPerHour, HOUR_MS)).success,
  contain: containAsSystem(logger),
  now: () => new Date(),
  logger,
});

const failureText = (result: AdminUsersBulkResult): string | null => {
  if (result.failed.length > 0)
    return `${result.failed.length} account(s) failed: ${result.failed[0].error}`.slice(0, 300);
  if (result.partial) return `${result.remaining} account(s) not attempted (time budget)`;
  return null;
};

/** Decides, and in enforce mode acts on, one assessment. Throws only on a database failure. */
export async function applyAutoContainment(
  assessment: AbuseAssessmentItem,
  deps: AutoContainmentDeps
): Promise<AutoContainmentRunResult> {
  const config = await deps.loadConfig();
  if (config.mode === 'off') return { status: 'skipped', reason: 'mode_off' };
  const detection = await deps.findDetection(assessment.detectionId);
  if (!detection) return { status: 'skipped', reason: 'detection_not_found' };

  const decision = decideContainment({ assessment, detection, config });
  if (decision.kind === 'skip') return { status: 'skipped', reason: decision.why };
  // Before taking a slot, so a detection already decided never spends the hour's budget.
  if (await deps.decisions.findByDetectionId(detection.id)) return { status: 'skipped', reason: 'already_decided' };

  const mode = config.mode;
  const base = {
    detectionId: detection.id,
    assessmentId: assessment.id,
    mode,
    userIds: decision.userIds,
    confidence: assessment.confidence ?? 0,
    reason: decision.reason,
    batchId: null,
    error: null,
    decidedAt: deps.now(),
  };
  const capped = !(await deps.takeHourlySlot(config.maxPerHour));
  const outcome = capped ? 'capped' : mode === 'shadow' ? 'would_contain' : 'pending';
  const recorded = await deps.decisions.recordOnce({ ...base, outcome });
  if (!recorded) return { status: 'skipped', reason: 'already_decided' };

  const logMeta = {
    detectionId: detection.id,
    assessmentId: assessment.id,
    mode,
    outcome,
    accounts: decision.userIds.length,
  };
  if (outcome !== 'pending') {
    // Capped decisions need an admin: warn so the alarm on this log line sees them.
    if (capped) deps.logger.warn('[AUTO_CONTAINMENT] decision capped by the hourly limit', logMeta);
    else deps.logger.info('[AUTO_CONTAINMENT] decision recorded', logMeta);
    return { status: 'decided', decision: recorded };
  }

  let finished: Pick<AutoContainmentDecisionItem, 'outcome' | 'batchId' | 'error'>;
  try {
    const result = await deps.contain({
      userIds: decision.userIds,
      reason: decision.reason,
      idempotencyKey: `auto-containment:${detection.id}`,
      blockEmailDomains: config.blockEmailDomains,
    });
    const error = result ? failureText(result) : null;
    finished = { outcome: error ? 'failed' : 'contained', batchId: result?.batchId ?? null, error };
  } catch (error) {
    finished = {
      outcome: 'failed',
      batchId: null,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
  await deps.decisions.finish(detection.id, finished);
  const meta = { ...logMeta, outcome: finished.outcome, batchId: finished.batchId };
  if (finished.outcome === 'failed')
    deps.logger.error('[AUTO_CONTAINMENT] containment failed', { ...meta, error: finished.error });
  else deps.logger.info('[AUTO_CONTAINMENT] accounts contained', meta);
  return { status: 'decided', decision: { ...recorded, ...finished } };
}
