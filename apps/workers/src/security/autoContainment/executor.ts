import {
  type AbuseAssessmentItem,
  type AutoContainmentConfig,
  type AutoContainmentDecisionItem,
  type GraduatedInterventionTier,
  type InterventionHold,
  type LinkRuleFacts,
  type ShadowDetectionItem,
} from '@bike4mind/common';
import {
  autoContainmentDecisionRepository,
  cacheRepository,
  shadowDetectionRepository,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { loadAutoContainmentConfig } from '@bike4mind/server-utils/security/autoContainment/config';
import { loadLinkRuleFacts } from '@bike4mind/server-utils/security/autoContainment/linkRuleFacts';
import type { AdminUsersBulkResult } from '@bike4mind/server-utils/app/utils/adminUsersBulk';
import { usersBulkExecuteDepsFor, usersBulkResolveDeps } from '@bike4mind/server-utils/admin/usersBulk/adapters';
import { executeAdminUsersBulk } from '@bike4mind/server-utils/admin/usersBulk/execute';
import { cohortHashOf, resolveAdminUsersBulk } from '@bike4mind/server-utils/admin/usersBulk/resolve';
import { systemAuditWriter } from '@workers/utils/systemAuditWriter';
import {
  decideIntervention,
  linkRulesMayOverride,
  type InterventionDecision,
  type InterventionSkipReason,
} from './policy';

/**
 * Automated containment: turns an `abuse` judgment on a shadow detection into the admin bulk Contain
 * (suspend, positive balance removed, API keys revoked, realtime sessions ended, optionally owned
 * email domains blocked), attributed to a system actor with the evidence as the audit reason.
 *
 * - autoContainmentConfig.mode gates it: off does nothing, shadow (the default) records the decision
 *   and changes no account, enforce contains.
 * - One graduated decision and one independent Contain decision per revision, so a re-sweep or a cached judgment never acts twice; a
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
 * - Graduated tiers (limit, verify, review, holdGrant) share the claim, the per-(tier, mode) hourly cap
 *   and the verdict recheck, but only add a per-decision hold to each account (users.interventionHolds).
 *   They never revoke keys, remove balance, or touch moderation, review state or a manual grant hold.
 */

const HOUR_MS = 60 * 60 * 1000;
// ms. Past the bulk path's IDEMPOTENCY_TTL_MS (10 min), so a retry re-executes rather than replaying a partial result.
export const STALE_PENDING_MS = 15 * 60 * 1000;
const hourlyKey = (mode: AutoContainmentDecisionItem['mode'], tier?: GraduatedInterventionTier) =>
  tier ? `autoContainment:decisions:${tier}:${mode}` : `autoContainment:decisions:${mode}`;
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
  decisions: Pick<
    typeof autoContainmentDecisionRepository,
    'listForDetection' | 'recordOnce' | 'reclaim' | 'finish' | 'release'
  >;
  /** Takes one decision from the hourly window of the mode (Contain) or of the tier and mode; false when it is spent. */
  takeHourlySlot: (
    mode: AutoContainmentDecisionItem['mode'],
    maxPerHour: number,
    tier?: GraduatedInterventionTier
  ) => Promise<boolean>;
  contain: (request: ContainRequest) => Promise<AdminUsersBulkResult | null>;
  /** Adds the hold unless that decision's hold is already on the account; false when it was not added. */
  applyHold: (userId: string, hold: InterventionHold, startedAt: Date) => Promise<boolean>;
  /** Commits the per-account receipt and graduated-hold release in one transaction. */
  releaseContainedHolds: (decisionId: string, userIds: string[]) => Promise<void>;
  /** Lifts one decision's hold from the account; false when it was not on it. */
  releaseHold: (userId: string, decisionId: string) => Promise<boolean>;
  /** One audit row per account a graduated hold reached. */
  auditHold: (userId: string, decision: AutoContainmentDecisionItem) => Promise<void>;
  /** Whether a verification flow can clear a verify hold; without one, verify decisions become review. */
  verificationAvailable: () => Promise<boolean>;
  /** Link-rule facts for the detection's accounts; fails closed per fact, never throws. */
  loadLinkRuleFacts: (userIds: string[], config: AutoContainmentConfig) => Promise<LinkRuleFacts[]>;
  now: () => Date;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
};

export type AutoContainmentRunResult =
  | { status: 'skipped'; reason: InterventionSkipReason | 'detection_not_found' | 'already_decided' }
  | { status: 'decided'; decision: AutoContainmentDecisionItem };

// Re-exported so the rule modules beside this one keep one import site for the containment policy.
export { loadAutoContainmentConfig };

/** The Contain path with a system actor; null when no account on the request is eligible (full admins never are; accounts with only delegated admin access can be). */
export const containAsSystem =
  (logger?: Logger) =>
  async (request: ContainRequest): Promise<AdminUsersBulkResult | null> => {
    const now = new Date();
    const target = { kind: 'ids' as const, userIds: request.userIds };
    const cohort = await resolveAdminUsersBulk(target, [], usersBulkResolveDeps, now, { actorIsFullAdmin: true });
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
      { id: AUTO_CONTAINMENT_ACTOR_ID, selfIds: [], fullAdmin: true },
      usersBulkExecuteDepsFor(systemAuditWriter(AUTO_CONTAINMENT_ACTOR, AUDIT_ROUTE, logger), request.reason, logger)
    );
  };

export const liveAutoContainmentDeps = (logger: Logger): AutoContainmentDeps => ({
  loadConfig: loadAutoContainmentConfig,
  findDetection: id => shadowDetectionRepository.findById(id),
  decisions: autoContainmentDecisionRepository,
  takeHourlySlot: async (mode, maxPerHour, tier) =>
    maxPerHour > 0 &&
    (await cacheRepository.tryIncrementWithinLimitFixedWindow(hourlyKey(mode, tier), maxPerHour, HOUR_MS)).success,
  contain: containAsSystem(logger),
  applyHold: (userId, hold, startedAt) => userRepository.addClaimedInterventionHold(userId, hold, startedAt),
  releaseContainedHolds: (decisionId, userIds) =>
    userRepository.releaseContainedInterventionHolds(decisionId, userIds, {
      by: AUTO_CONTAINMENT_ACTOR_ID,
      now: new Date(),
    }),
  releaseHold: (userId, decisionId) =>
    userRepository.releaseInterventionHold(userId, decisionId, { by: AUTO_CONTAINMENT_ACTOR_ID, now: new Date() }),
  auditHold: async (userId, decision) => {
    await systemAuditWriter(
      AUTO_CONTAINMENT_ACTOR,
      AUDIT_ROUTE,
      logger
    )({
      action: 'user.intervention_hold.applied',
      target: { kind: 'user', id: userId, displayName: userId },
      summary: `Automated ${decision.tier} hold (policy v${decision.policyVersion})`,
      reason: decision.reason,
      details: {
        decisionId: decision.id,
        detectionId: decision.detectionId,
        tier: decision.tier,
        policyVersion: decision.policyVersion,
        scope: decision.scope,
        expiresAt: decision.expiresAt?.toISOString() ?? null,
      },
    });
  },
  // No card or phone verification flow calls unlockSignupGrant yet, so a verify decision is recorded as review.
  verificationAvailable: async () => false,
  loadLinkRuleFacts: (userIds, config) => loadLinkRuleFacts(userIds, config, undefined, logger),
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
  decided: Extract<InterventionDecision, { kind: 'act' }>,
  mode: AutoContainmentDecisionItem['mode'],
  deps: AutoContainmentDeps
): Promise<{ decision: AutoContainmentDecisionItem; retried: boolean } | null> {
  const now = deps.now();
  const staleBefore = new Date(now.getTime() - STALE_PENDING_MS);
  const prior = await deps.decisions.listForDetection(detection.id);
  const current = prior.find(row => row.revision === detection.revision && row.tier === decided.tier);
  // A graduated hold never stands in for Contain, so only earlier Contain rows cover an account for it.
  const covering = decided.tier === 'contain' ? prior.filter(row => row.tier === 'contain') : prior;
  const covered = new Set(covering.filter(row => row !== current).flatMap(row => row.userIds));
  const userIds = decided.userIds.filter(userId => !covered.has(userId));
  if (current) {
    // Reclaim keeps the row's decider, accounts and audit fields, so it must not carry another decider's claim.
    if (decided.tier !== 'contain' && current.decidedBy !== decided.decidedBy) return null;
    const reclaimed = await deps.decisions.reclaim(current.id, {
      staleBefore,
      cappedBefore: new Date(now.getTime() - HOUR_MS),
      now,
      mode,
    });
    return reclaimed ? { decision: reclaimed, retried: current.outcome === 'pending' } : null;
  }
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
    // Contain keeps the record it wrote before tiers existed.
    ...(decided.tier === 'contain'
      ? {}
      : {
          tier: decided.tier,
          policyVersion: decided.policyVersion,
          scope: decided.scope,
          expiresAt: decided.expiresAt,
          decidedBy: decided.decidedBy,
          linkRules: decided.linkRules,
          modelJudgment: { result: assessment.result, confidence: assessment.confidence },
        }),
  });
  return recorded ? { decision: recorded, retried: false } : null;
}

/** A committed receipt names accounts; an applied count alone never authorizes lifting a hold. */
async function releaseContainedHolds(
  detectionId: string,
  requestedUserIds: string[],
  result: AdminUsersBulkResult | null,
  deps: AutoContainmentDeps
): Promise<void> {
  const committed = [...new Set(result?.committedUserIds ?? [])].filter(id => requestedUserIds.includes(id));
  if (committed.length === 0) return;
  try {
    // Refresh after Contain commits to include a graduated claim created while it was running.
    const rows = await deps.decisions.listForDetection(detectionId);
    for (const row of rows) {
      if (row.tier === 'contain' || row.releasedAt) continue;
      const selected = committed.filter(id => row.userIds.includes(id));
      if (selected.length === 0) continue;
      try {
        await deps.releaseContainedHolds(row.id, selected);
      } catch (error) {
        deps.logger.error('[AUTO_CONTAINMENT] releasing contained account holds failed', {
          decisionId: row.id,
          error: errorText(error),
        });
      }
    }
  } catch (error) {
    deps.logger.error('[AUTO_CONTAINMENT] loading graduated decisions after containment failed', {
      detectionId,
      error: errorText(error),
    });
  }
}

async function linkFactsFor(
  detection: ShadowDetectionItem,
  config: AutoContainmentConfig,
  deps: AutoContainmentDeps
): Promise<LinkRuleFacts[] | null> {
  try {
    return await deps.loadLinkRuleFacts(detection.userIds, config);
  } catch (error) {
    deps.logger.error('[AUTO_CONTAINMENT] link-rule facts unavailable', {
      detectionId: detection.id,
      error: errorText(error),
    });
    return null;
  }
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

  const input = {
    assessment,
    detection,
    config,
    now: deps.now(),
    verificationAvailable: await deps.verificationAvailable(),
  };
  const byModel = decideIntervention(input);
  // The facts cost several reads per account, so they are loaded only when a rule could replace the model's skip.
  const linkFacts = linkRulesMayOverride(input, byModel) ? await linkFactsFor(detection, config, deps) : null;
  const decided = linkFacts ? decideIntervention({ ...input, linkFacts }) : byModel;
  if (decided.kind === 'skip') return { status: 'skipped', reason: decided.why };
  if (decided.tier !== 'contain') return applyGraduatedTier(assessment, detection, decided, config, deps);

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
    if (!(await deps.decisions.finish(decision.id, finished, decision.decidedAt))) {
      return { status: 'skipped', reason: 'already_decided' };
    }
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
    const result = await deps.contain({
      userIds: decision.userIds,
      reason: decision.reason,
      idempotencyKey: `auto-containment:${detection.id}:${detection.revision}`,
      blockEmailDomains: config.blockEmailDomains,
    });
    finished = finishedFrom(result);
    await releaseContainedHolds(detection.id, decision.userIds, result, deps);
  } catch (error) {
    finished = { outcome: 'failed', batchId: null, error: errorText(error) };
  }
  const meta = { ...logMeta, outcome: finished.outcome, batchId: finished.batchId, error: finished.error };
  if (finished.outcome === 'failed') deps.logger.error('[AUTO_CONTAINMENT] containment failed', meta);
  else if (finished.outcome === 'pending') deps.logger.warn('[AUTO_CONTAINMENT] containment ran out of time', meta);
  else deps.logger.info('[AUTO_CONTAINMENT] accounts contained', meta);
  return settle(finished);
}

/** A graduated tier: same claim, cap and verdict recheck as Contain, then one hold per account. */
async function applyGraduatedTier(
  assessment: AbuseAssessmentItem,
  detection: ShadowDetectionItem,
  decided: Extract<InterventionDecision, { kind: 'act' }>,
  config: AutoContainmentConfig,
  deps: AutoContainmentDeps
): Promise<AutoContainmentRunResult> {
  const tier = decided.tier as GraduatedInterventionTier;
  const { mode } = decided;
  const claim = await claimDecision(assessment, detection, decided, mode, deps);
  if (!claim) return { status: 'skipped', reason: 'already_decided' };
  const { decision } = claim;
  const logMeta = {
    detectionId: detection.id,
    revision: detection.revision,
    tier,
    mode,
    accounts: decision.userIds.length,
  };
  if (claim.retried) deps.logger.warn('[AUTO_CONTAINMENT] retrying a decision a run left pending', logMeta);

  const settle = async (finished: Finished): Promise<AutoContainmentRunResult> => {
    if (!(await deps.decisions.finish(decision.id, finished, decision.decidedAt))) {
      return { status: 'skipped', reason: 'already_decided' };
    }
    return { status: 'decided', decision: { ...decision, ...finished } };
  };

  if (!(await deps.takeHourlySlot(mode, config.tiers[tier].maxPerHour, tier))) {
    deps.logger.warn('[AUTO_CONTAINMENT] decision capped by the hourly limit', { ...logMeta, outcome: 'capped' });
    return settle({ outcome: 'capped', batchId: null, error: null });
  }
  if (mode === 'shadow') {
    deps.logger.info('[AUTO_CONTAINMENT] decision recorded', { ...logMeta, outcome: 'would_intervene' });
    return settle({ outcome: 'would_intervene', batchId: null, error: null });
  }

  const latest = await deps.findDetection(detection.id);
  if (!latest || latest.verdict !== null) {
    deps.logger.info('[AUTO_CONTAINMENT] decision withdrawn by an admin verdict', { ...logMeta, outcome: 'withdrawn' });
    return settle({ outcome: 'withdrawn', batchId: null, error: null });
  }

  // The claim stamps expiresAt; a reclaimed retry reuses the stored row, so every account gets the same window.
  const expiresAt = decision.expiresAt ?? decided.expiresAt;
  if (!expiresAt) return settle({ outcome: 'failed', batchId: null, error: 'graduated decision has no expiry' });
  const hold: InterventionHold = {
    decisionId: decision.id,
    detectionId: detection.id,
    tier,
    policyVersion: decision.policyVersion ?? decided.policyVersion,
    reason: decision.reason,
    appliedAt: deps.now(),
    expiresAt,
    releasedAt: null,
    releasedBy: null,
    ...(tier === 'limit' ? { creditsPerHour: config.tiers.limit.creditsPerHour } : {}),
  };
  const failures: string[] = [];
  for (const userId of decision.userIds) {
    try {
      // Idempotent by decisionId, so a retried pending decision never stacks a second hold.
      if (await deps.applyHold(userId, hold, decision.decidedAt)) await deps.auditHold(userId, decision);
    } catch (error) {
      failures.push(`${userId}: ${errorText(error)}`);
    }
  }
  const finished: Finished =
    failures.length > 0
      ? {
          outcome: 'failed',
          batchId: null,
          error: `${failures.length} account(s) failed: ${failures[0]}`.slice(0, 300),
        }
      : { outcome: 'intervened', batchId: null, error: null };
  const meta = { ...logMeta, outcome: finished.outcome, error: finished.error };
  if (finished.outcome === 'failed') deps.logger.error('[AUTO_CONTAINMENT] intervention failed', meta);
  else deps.logger.info('[AUTO_CONTAINMENT] intervention applied', meta);
  const result = await settle(finished);
  await releaseIfLegitimateVerdictLanded(decision, deps, logMeta);
  return result;
}

/**
 * A legitimate verdict committed while the holds went on found this decision still pending, and the
 * verdict route releases only settled ones (apps/client/server/security/interventionRelease.ts), so
 * the holds are lifted here. Runs after settling, so a verdict landing later sees the settled decision.
 */
async function releaseIfLegitimateVerdictLanded(
  decision: AutoContainmentDecisionItem,
  deps: AutoContainmentDeps,
  logMeta: Record<string, unknown>
): Promise<void> {
  try {
    const latest = await deps.findDetection(decision.detectionId);
    if (!latest?.verdict?.startsWith('legitimate_')) return;
    for (const userId of decision.userIds) await deps.releaseHold(userId, decision.id);
    await deps.decisions.release(decision.id, {
      by: AUTO_CONTAINMENT_ACTOR_ID,
      reason: `Released on a ${latest.verdict} verdict that landed while the hold was applied`,
      condition: 'legitimate_verdict',
      now: deps.now(),
    });
    deps.logger.info('[AUTO_CONTAINMENT] hold released on a verdict that landed mid-apply', logMeta);
  } catch (error) {
    deps.logger.error('[AUTO_CONTAINMENT] releasing holds after a mid-apply verdict failed', {
      ...logMeta,
      error: errorText(error),
    });
  }
}
