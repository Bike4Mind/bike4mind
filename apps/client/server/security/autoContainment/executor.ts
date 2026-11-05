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
 * - One decision per (detection, revision), so a re-sweep or a cached judgment never acts twice; a
 *   campaign detection that gains members after a decision is decided again for the new members only.
 *   An admin verdict on the detection always wins, re-read right before the Contain runs.
 * - The decision is claimed (inserted `pending`) before an hourly slot is taken, so a run that loses
 *   the claim spends nothing. A fixed one-hour window per mode caps decisions; over it, the decision
 *   is recorded `capped` and is re-evaluated after the window resets. Shadow grading reads these
 *   records against the detections' admin verdicts.
 * - A claim left `pending` past STALE_PENDING_MS (the run died, or the Contain ran out of time budget)
 *   is reclaimed and retried with the same idempotency key; the bulk path skips users already contained.
 * - Reversal is the user profile's Unsuspend; keys stay revoked (the user mints new ones), as after
 *   any suspension.
 */

const HOUR_MS = 60 * 60 * 1000;
// ms. Past the bulk path's IDEMPOTENCY_TTL_MS (10 min), so a retry re-executes rather than replaying a partial result.
export const STALE_PENDING_MS = 15 * 60 * 1000;
const hourlyKey = (mode: AutoContainmentDecisionItem['mode']) => `autoContainment:decisions:${mode}`;
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
  decisions: Pick<typeof autoContainmentDecisionRepository, 'listForDetection' | 'recordOnce' | 'reclaim' | 'finish'>;
  /** Takes one decision from the mode's hourly window; false when it is spent. */
  takeHourlySlot: (mode: AutoContainmentDecisionItem['mode'], maxPerHour: number) => Promise<boolean>;
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
  takeHourlySlot: async (mode, maxPerHour) =>
    maxPerHour > 0 &&
    (await cacheRepository.tryIncrementWithinLimitFixedWindow(hourlyKey(mode), maxPerHour, HOUR_MS)).success,
  contain: containAsSystem(logger),
  now: () => new Date(),
  logger,
});

type Finished = Pick<AutoContainmentDecisionItem, 'outcome' | 'batchId' | 'error'>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** How a Contain run ends up on the decision. A time-budget partial stays `pending`, so it is retried. */
const finishedFrom = (result: AdminUsersBulkResult | null): Finished => {
  if (!result) return { outcome: 'failed', batchId: null, error: 'no eligible accounts (admins or deleted)' };
  if (result.failed.length > 0)
    return {
      outcome: 'failed',
      batchId: result.batchId,
      error: `${result.failed.length} account(s) failed: ${result.failed[0].error}`.slice(0, 300),
    };
  if (result.partial)
    return {
      outcome: 'pending',
      batchId: result.batchId,
      error: `${result.remaining} account(s) not attempted (time budget); retried after the stale window`,
    };
  return { outcome: 'contained', batchId: result.batchId, error: null };
};

/**
 * The decision this run owns for the detection's current revision: a fresh claim, or one an earlier
 * run left unfinished. Null when the revision is already decided, or every account on it already is.
 */
async function claimDecision(
  assessment: AbuseAssessmentItem,
  detection: ShadowDetectionItem,
  decided: { userIds: string[]; reason: string },
  mode: AutoContainmentDecisionItem['mode'],
  deps: AutoContainmentDeps
): Promise<{ decision: AutoContainmentDecisionItem; retried: boolean } | null> {
  const now = deps.now();
  const prior = await deps.decisions.listForDetection(detection.id);
  const current = prior.find(row => row.revision === detection.revision);
  if (current) {
    const reclaimed = await deps.decisions.reclaim(current.id, {
      staleBefore: new Date(now.getTime() - STALE_PENDING_MS),
      cappedBefore: new Date(now.getTime() - HOUR_MS),
      now,
      mode,
    });
    return reclaimed ? { decision: reclaimed, retried: current.outcome === 'pending' } : null;
  }
  const covered = new Set(prior.flatMap(row => row.userIds));
  const userIds = decided.userIds.filter(userId => !covered.has(userId));
  if (userIds.length === 0) return null;
  const recorded = await deps.decisions.recordOnce({
    detectionId: detection.id,
    revision: detection.revision,
    assessmentId: assessment.id,
    mode,
    outcome: 'pending',
    userIds,
    confidence: assessment.confidence ?? 0,
    reason: decided.reason,
    batchId: null,
    error: null,
    decidedAt: now,
  });
  return recorded ? { decision: recorded, retried: false } : null;
}

/** Decides, and in enforce mode acts on, one assessment. Throws only on a database failure. */
export async function applyAutoContainment(
  assessment: AbuseAssessmentItem,
  deps: AutoContainmentDeps
): Promise<AutoContainmentRunResult> {
  const config = await deps.loadConfig();
  if (config.mode === 'off') return { status: 'skipped', reason: 'mode_off' };
  const detection = await deps.findDetection(assessment.detectionId);
  if (!detection) return { status: 'skipped', reason: 'detection_not_found' };

  const decided = decideContainment({ assessment, detection, config });
  if (decided.kind === 'skip') return { status: 'skipped', reason: decided.why };

  const mode = config.mode;
  const claim = await claimDecision(assessment, detection, decided, mode, deps);
  if (!claim) return { status: 'skipped', reason: 'already_decided' };
  const { decision } = claim;
  const logMeta = {
    detectionId: detection.id,
    revision: detection.revision,
    assessmentId: assessment.id,
    mode,
    accounts: decision.userIds.length,
  };
  if (claim.retried) deps.logger.warn('[AUTO_CONTAINMENT] retrying a decision a run left pending', logMeta);

  const settle = async (finished: Finished): Promise<AutoContainmentRunResult> => {
    await deps.decisions.finish(decision.id, finished);
    return { status: 'decided', decision: { ...decision, ...finished } };
  };

  if (!(await deps.takeHourlySlot(mode, config.maxPerHour))) {
    // Capped decisions need an admin: warn so the alarm on this log line sees them.
    deps.logger.warn('[AUTO_CONTAINMENT] decision capped by the hourly limit', { ...logMeta, outcome: 'capped' });
    return settle({ outcome: 'capped', batchId: null, error: null });
  }
  if (mode === 'shadow') {
    deps.logger.info('[AUTO_CONTAINMENT] decision recorded', { ...logMeta, outcome: 'would_contain' });
    return settle({ outcome: 'would_contain', batchId: null, error: null });
  }

  // An admin may have ruled while this run was assessing and claiming: their verdict wins.
  const latest = await deps.findDetection(detection.id);
  if (!latest || latest.verdict !== null) {
    deps.logger.info('[AUTO_CONTAINMENT] decision withdrawn by an admin verdict', { ...logMeta, outcome: 'withdrawn' });
    return settle({ outcome: 'withdrawn', batchId: null, error: null });
  }

  let finished: Finished;
  try {
    finished = finishedFrom(
      await deps.contain({
        userIds: decision.userIds,
        reason: decision.reason,
        idempotencyKey: `auto-containment:${detection.id}:${detection.revision}`,
        blockEmailDomains: config.blockEmailDomains,
      })
    );
  } catch (error) {
    finished = { outcome: 'failed', batchId: null, error: errorText(error) };
  }
  const meta = { ...logMeta, outcome: finished.outcome, batchId: finished.batchId, error: finished.error };
  if (finished.outcome === 'failed') deps.logger.error('[AUTO_CONTAINMENT] containment failed', meta);
  else if (finished.outcome === 'pending') deps.logger.warn('[AUTO_CONTAINMENT] containment ran out of time', meta);
  else deps.logger.info('[AUTO_CONTAINMENT] accounts contained', meta);
  return settle(finished);
}
