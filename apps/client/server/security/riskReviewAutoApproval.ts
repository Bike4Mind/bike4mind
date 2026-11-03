import {
  SignupRiskAutoApprovalSchema,
  type IUserDocument,
  type SignupRiskAutoApproval,
  type SignupRiskAutoApprovalPolicy,
} from '@bike4mind/common';
import {
  adminAuditLogRepository,
  adminSettingsRepository,
  paymentAttemptRepository,
  shadowDetectionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { adminAuditService, userService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { systemAuditActor } from '@server/utils/adminAudit';

/**
 * Approves a pending signup risk review on evidence an abuser cannot cheaply produce, so a
 * legitimate account is not held from AI access until an admin gets to it. Only ever moves pending
 * to approved (which an admin can reopen from the Risk review tab); never moves anything into
 * pending, and no model verdict is evidence here. Rules and defaults: SignupRiskAutoApprovalSchema.
 * Triggers: the Stripe webhook after a payment succeeds, and an hourly sweep for windows and the
 * quiet-account rule (apps/workers/src/cron/signupGrantHeldRelease.ts).
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Payment attempts read per account; more than enough to find one qualifying payment. */
const PAYMENT_LOOKBACK = 50;

/** Stripe Radar's lowest `outcome.risk_level`; anything else (or no Radar assessment) does not qualify. */
const RADAR_NORMAL_RISK = 'normal';

const AUDIT_ACTOR = 'signup-risk-auto-approval';

const POLICY_REASONS: Readonly<Record<SignupRiskAutoApprovalPolicy, string>> = {
  settled_payment: 'Successful card payment rated normal by Stripe Radar, on a card no other account has used',
  quiet_account: 'Account aged past the quiet-account rule with no new risk signals and no open detections',
};

export type RiskReviewAutoApprovalTrigger = 'stripe/webhook' | 'cron/signupGrantHeldRelease';

export type RiskReviewAutoApprovalOutcome =
  | { outcome: 'approved'; policy: SignupRiskAutoApprovalPolicy }
  | { outcome: 'skipped'; reason: 'not_pending' | 'blocked' | 'no_evidence' };

export const loadRiskReviewAutoApprovalRules = async (): Promise<SignupRiskAutoApproval> =>
  getSettingsValue(
    'signupRiskAutoApproval',
    await getSettingsMap({ adminSettings: adminSettingsRepository }),
    SignupRiskAutoApprovalSchema.parse({})
  );

const anyRuleEnabled = (rules: SignupRiskAutoApproval) => rules.settledPayment.enabled || rules.quietAccount.enabled;

// A refund, dispute or early fraud warning forfeits payment unlocks (paymentUnlockForfeit.ts); it
// disqualifies the account from both rules, not only the payment one.
const isDisqualified = (user: IUserDocument) =>
  userService.accountBlockReasons(user).length > 0 || !!user.signupGrant?.unlockForfeited;

async function hasSettledPayment(
  userId: string,
  rule: SignupRiskAutoApproval['settledPayment'],
  now: Date
): Promise<boolean> {
  const attempts = await paymentAttemptRepository.findByUser(userId, PAYMENT_LOOKBACK);
  if (attempts.some(attempt => attempt.radarBlocked)) return false;
  const standingSince = now.getTime() - rule.minPaymentAgeHours * HOUR_MS;
  for (const attempt of attempts) {
    if (attempt.outcome !== 'succeeded' || attempt.riskLevel !== RADAR_NORMAL_RISK) continue;
    if (new Date(attempt.createdAt).getTime() > standingSince || attempt.cardFingerprints.length === 0) continue;
    // A card shared across accounts is the farming pattern; a truncated count (null) is not proof of one owner.
    const accountCounts = await Promise.all(
      attempt.cardFingerprints.map(fingerprint => paymentAttemptRepository.countAccountsForCard(fingerprint))
    );
    if (accountCounts.every(count => count === 1)) return true;
  }
  return false;
}

async function isQuietAccount(
  user: IUserDocument,
  rule: SignupRiskAutoApproval['quietAccount'],
  now: Date
): Promise<boolean> {
  const riskScore = user.riskScore;
  if (!riskScore || riskScore.score > rule.maxScore) return false;
  if (now.getTime() - new Date(user.createdAt).getTime() < rule.minAccountAgeDays * DAY_MS) return false;
  // Every rescore follows a risk-relevant event (email verification, a new API key).
  if (now.getTime() - new Date(riskScore.computedAt).getTime() < rule.minQuietDays * DAY_MS) return false;
  return (await shadowDetectionRepository.countOpenForUser(user.id)) === 0;
}

async function findQualifyingPolicy(
  user: IUserDocument,
  rules: SignupRiskAutoApproval,
  now: Date
): Promise<SignupRiskAutoApprovalPolicy | null> {
  if (rules.settledPayment.enabled && (await hasSettledPayment(user.id, rules.settledPayment, now)))
    return 'settled_payment';
  if (rules.quietAccount.enabled && (await isQuietAccount(user, rules.quietAccount, now))) return 'quiet_account';
  return null;
}

/**
 * Approves the user's pending review when a rule's evidence holds, with a strict system-attributed
 * audit entry in the same transaction. Throws on a database or audit failure.
 */
export async function autoApproveRiskReview(
  userId: string,
  {
    rules,
    trigger,
    now = new Date(),
  }: { rules: SignupRiskAutoApproval; trigger: RiskReviewAutoApprovalTrigger; now?: Date }
): Promise<RiskReviewAutoApprovalOutcome> {
  const user = await userRepository.findById(userId);
  if (user?.riskScore?.reviewState !== 'pending') return { outcome: 'skipped', reason: 'not_pending' };
  if (isDisqualified(user)) return { outcome: 'skipped', reason: 'blocked' };
  const policy = await findQualifyingPolicy(user, rules, now);
  if (!policy) return { outcome: 'skipped', reason: 'no_evidence' };

  const approved = await withTransaction(async () => {
    if (!(await userRepository.autoApproveRiskReview(userId, { policy, decidedAt: now }))) return false;
    await adminAuditService.recordAdminAction(
      {
        action: 'user.signup_risk.auto_approved',
        actor: systemAuditActor(AUDIT_ACTOR),
        target: { kind: 'user', id: userId, displayName: user.email ?? user.username ?? userId },
        summary: 'approved a flagged signup automatically',
        reason: POLICY_REASONS[policy],
        context: { source: 'worker', route: trigger },
        changes: [{ field: 'riskScore.reviewState', before: 'pending', after: 'approved' }],
        details: { policy, score: user.riskScore?.score ?? null },
        occurredAt: now,
      },
      { db: { adminAuditLog: adminAuditLogRepository } }
    );
    return true;
  });
  return approved ? { outcome: 'approved', policy } : { outcome: 'skipped', reason: 'not_pending' };
}

/** The payment-event trigger: a no-op unless the user is pending. Never throws; the sweep retries a miss. */
export async function autoApproveRiskReviewAfterPayment(userId: string, logger: Logger): Promise<void> {
  try {
    const user = await userRepository.findById(userId);
    if (user?.riskScore?.reviewState !== 'pending') return;
    const rules = await loadRiskReviewAutoApprovalRules();
    if (!rules.settledPayment.enabled) return;
    const result = await autoApproveRiskReview(userId, { rules, trigger: 'stripe/webhook' });
    logger.info('[RiskReviewAutoApproval] payment trigger', { userId, ...result });
  } catch (error) {
    logger.error('[RiskReviewAutoApproval] payment trigger failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export type RiskReviewAutoApprovalSweepResult = { scanned: number; approved: number; failed: number };

/** Walks the pending queue in id order, at most `maxUsers` per run. A per-user failure is counted, not thrown. */
export async function sweepRiskReviewAutoApprovals(
  logger: Pick<Logger, 'error'>,
  { maxUsers, pageSize = 100, now = new Date() }: { maxUsers: number; pageSize?: number; now?: Date }
): Promise<RiskReviewAutoApprovalSweepResult> {
  const result: RiskReviewAutoApprovalSweepResult = { scanned: 0, approved: 0, failed: 0 };
  const rules = await loadRiskReviewAutoApprovalRules();
  if (!anyRuleEnabled(rules)) return result;
  let afterId: string | undefined;
  while (result.scanned < maxUsers) {
    const ids = await userRepository.findPendingRiskReviewIds({
      afterId,
      limit: Math.min(pageSize, maxUsers - result.scanned),
    });
    if (!ids.length) break;
    for (const userId of ids) {
      result.scanned++;
      try {
        const outcome = await autoApproveRiskReview(userId, { rules, trigger: 'cron/signupGrantHeldRelease', now });
        if (outcome.outcome === 'approved') result.approved++;
      } catch (error) {
        result.failed++;
        logger.error('[RiskReviewAutoApproval] sweep failed for user', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    afterId = ids[ids.length - 1];
  }
  return result;
}
