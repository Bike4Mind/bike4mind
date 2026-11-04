import {
  CreditHolderType,
  hasPaidSignupDrip,
  isPaymentUnlockReason,
  isSignupGrantBlocked,
  PENDING_FREE_CREDITS_TAG,
  resolveSignupGrantSchedule,
  signupGrantDripOpen,
  signupGrantDripRemaining,
  settingsMap,
  signupGrantRemaining,
  signupGrantUnlockCredits,
  SignupRiskScoringSchema,
  type IUserDocument,
  type PaymentUnlockReason,
  type SignupGrant,
  type SignupGrantUnlockReason,
  type SignupUnlockForfeitCause,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import { addCreditsWithLedgerRow, DuplicateCreditTransactionError } from '../creditService';
import type { FreeCreditAdapters, GrantFreeCreditsResult } from './freeCredits';
import {
  evaluateSignupRisk,
  isSignupGrantHeldForReview,
  signupRiskPolicySchema,
  type SignupRiskBand,
  type SignupRiskSignals,
} from './signupRisk';
import { accountBlockReasons, isAiAccessRevoked } from './accountState';
import { protectSignupCredits } from './signupProtection';
import {
  queueHeadBlocks,
  reserveSignupGrantBudget,
  signupGrantBudgetDay,
  type SignupGrantBudgetReservation,
} from './signupGrantBudget';

type GrantAdapters = FreeCreditAdapters & {
  audit?: (input: { userId: string; credits: number; creditTransactionId?: string }) => Promise<void>;
};

type AssessedGrantResult = GrantFreeCreditsResult & { assessedBand?: SignupRiskBand };

/** `unlockedOrgId` releases the full remainder and records the org that vouched for the account. */
export type SignupGrantValidator = (
  user: IUserDocument
) => Promise<boolean | { cumulativeCredits: number } | { unlockedOrgId: string }>;

/** One UTC day's activity drip: a fixed daily amount, bounded by the account-wide drip cap. */
type DripEvidence = { drip: { day: string; dailyCredits: number; dripCap: number; period?: string } };

const noGrant = (): GrantFreeCreditsResult => ({ creditsGranted: 0, currentCredits: null });

/** The ledger description of an unlock tranche; the row's `reason` carries the machine label. */
const SIGNUP_UNLOCK_DESCRIPTIONS: Readonly<Record<SignupGrantUnlockReason, string>> = {
  card_verified: 'card verified',
  phone_verified: 'phone verified',
  admin: 'released by an admin',
  activity: 'account activity',
  org_invite: 'organization invite accepted',
  github_verified: 'GitHub account verified',
  work_email_verified: 'work email verified',
  activity_drip: 'daily activity',
  subscription: 'paid subscription started',
};

const grantClock = (db: GrantAdapters['db']) => db.signupProtection?.grantBudget?.now?.() ?? new Date();

/** The grant without its payment hold; a fully released grant has nothing left to hold. */
function withoutHeldUnlock(grant: SignupGrant): SignupGrant {
  const { heldUnlock: _released, ...rest } = grant;
  return rest;
}

/** Card verification, subscription and admin releases are never throttled by the daily signup grant budget. */
const BUDGET_EXEMPT_REASONS: ReadonlySet<SignupGrantUnlockReason | undefined> = new Set([
  'card_verified',
  'subscription',
  'admin',
]);

class InboxGrantClaimDeniedError extends Error {}

function isReleaseEligible(
  user: IUserDocument | null | undefined,
  expected: SignupGrant['stage']
): user is IUserDocument & { signupGrant: SignupGrant } {
  if (!user?.signupGrant || accountBlockReasons(user).length || isAiAccessRevoked(user)) return false;
  if (isSignupGrantBlocked(user)) return false;
  if (expected === 'pending_email') return user.signupGrant.stage === expected;
  // An unpaid tranche blocks every unlock; unlockSignupGrant pays a held tranche first on a card or subscription unlock.
  return user.signupGrant.stage !== 'pending_email';
}

/**
 * A blocked account's pending tranche is withheld rather than a plain zero: releasePendingFreeCredits
 * strips PENDING_FREE_CREDITS_TAG on a non-withheld zero, which would strand the tranche after an unblock.
 */
function ineligibleResult(
  user: IUserDocument | null | undefined,
  expected: SignupGrant['stage']
): GrantFreeCreditsResult {
  return expected === 'pending_email' && user && isSignupGrantBlocked(user)
    ? { ...noGrant(), withheld: true }
    : noGrant();
}

/** Whether the stored risk score alone keeps the account in review (refreshSignupRiskScore's needsReview). */
async function scoreNeedsReview(score: number, adminSettings: GrantAdapters['db']['adminSettings']) {
  const setting = await adminSettings.findBySettingName('signupRiskScoring');
  let value: unknown = setting?.settingValue ?? {};
  try {
    if (typeof value === 'string') value = JSON.parse(value);
  } catch {
    value = undefined;
  }
  const parsed = SignupRiskScoringSchema.safeParse(value);
  // An unreadable setting keeps the account queued rather than releasing it unreviewed.
  return !parsed.success || score >= parsed.data.reviewThreshold;
}

async function releaseStage(
  userId: string,
  expected: SignupGrant['stage'],
  reason: SignupGrantUnlockReason | undefined,
  validate: (user: IUserDocument) => ReturnType<SignupGrantValidator> | Promise<DripEvidence | false>,
  adapters: GrantAdapters
): Promise<GrantFreeCreditsResult> {
  const { db, audit } = adapters;
  if (db.signupProtection) {
    const user = await db.users.findById(userId);
    if (!isReleaseEligible(user, expected)) return ineligibleResult(user, expected);
    if (!user.emailVerified) {
      if (expected === 'pending_email') throw new Error('Email verification required for signup grant');
      return noGrant();
    }
    // Detection may notify reviewers; keep it outside the retried payout transaction.
    if (await protectSignupCredits(userId, db)) {
      if (expected === 'pending_email') await db.users.addTagsToUser(userId, [PENDING_FREE_CREDITS_TAG]);
      await dropBudgetHold(db.users, userId, user.signupGrantHeldReason);
      return { ...noGrant(), withheld: true };
    }
  }
  // A re-run of the payout transaction re-reserves as a no-op, so every attempt's hold is kept for the refund.
  const reservations: SignupGrantBudgetReservation[] = [];
  const releaseReservations = () => Promise.all(reservations.map(held => held.release()));
  try {
    const result = await withTransaction<AssessedGrantResult>(async () => {
      const user = await db.users.findById(userId);
      if (!isReleaseEligible(user, expected)) return ineligibleResult(user, expected);
      const grant = user.signupGrant;
      const evidence = await validate(user);
      if (!evidence) return noGrant();
      const maximum = grant.signupCredits + grant.unlockCredits;
      if (
        ![grant.signupCredits, grant.unlockCredits, grant.creditsReleased, maximum].every(
          value => Number.isSafeInteger(value) && value >= 0
        ) ||
        grant.creditsReleased > maximum
      )
        throw new Error('Invalid staged grant amount');
      let assessment = user.signupGrantAssessment;
      let assessedBand: SignupRiskBand | undefined;
      let target: number;
      let dripAmount = 0;
      let unlockCredits = grant.unlockCredits;
      let dripRemainingAfter = 0;
      if (expected === 'pending_email') {
        if (!assessment) {
          const setting = await db.adminSettings.findBySettingName('signupGrantRiskPolicy');
          let policy: unknown = { enabled: false };
          let signals: SignupRiskSignals = { datacenter: user.signupMeta?.isDatacenter };
          try {
            if (setting)
              policy =
                typeof setting.settingValue === 'string' ? JSON.parse(setting.settingValue) : setting.settingValue;
          } catch {
            policy = undefined;
          }
          const parsedPolicy = signupRiskPolicySchema.safeParse(policy);
          if (adapters.collectRiskSignals && parsedPolicy.success && parsedPolicy.data.enabled) {
            try {
              signals = await adapters.collectRiskSignals(user);
            } catch {
              // Infrastructure failures are retryable, unlike a completed review decision.
              // Do not log collector contents: they can contain private signup observations.
              console.warn('[signup-risk] Observation collection failed; signup grant remains pending for retry');
              throw new Error('Signup risk observation collection unavailable; retry the signup grant');
            }
          }
          assessment = evaluateSignupRisk(policy, signals, grant.signupCredits);
          assessedBand = assessment.band;
          if (assessment.status === 'unavailable') {
            console.warn('[signup-risk] Assessment unavailable; holding signup grant');
          }
        }
        target = assessment.credits;
        if (!Number.isSafeInteger(target) || target < 0 || target > grant.signupCredits)
          throw new Error('Invalid signup assessment entitlement');
      } else {
        if (typeof evidence === 'object' && 'drip' in evidence) {
          const { day, dailyCredits, dripCap, period } = evidence.drip;
          const dripped = grant.dripCredits ?? 0;
          if (hasPaidSignupDrip(grant, day, period) || !Number.isSafeInteger(dripped) || dripped < 0) return noGrant();
          // A verification unlock already paid the whole entitlement; only a drip-completed grant reopens on a raised cap.
          if (!signupGrantDripOpen(grant)) return noGrant();
          dripAmount = Math.max(0, Math.min(dailyCredits, signupGrantDripRemaining(grant, dripCap)));
          target = grant.creditsReleased + dripAmount;
          // The live cap governs the drip, so a cap raised after enrollment grows the snapshot pool to fit,
          // and the grant stays open while the cap still has room.
          unlockCredits = Math.max(grant.unlockCredits, target - grant.signupCredits);
          dripRemainingAfter = signupGrantDripRemaining({ dripCredits: dripped + dripAmount }, dripCap);
        } else if (evidence === true || 'unlockedOrgId' in evidence) {
          unlockCredits = signupGrantUnlockCredits(grant, (await resolveDripLimits(db.adminSettings)).dripCap);
          target = grant.signupCredits + unlockCredits;
        } else {
          target = evidence.cumulativeCredits;
        }
        if (!Number.isSafeInteger(target) || target < 0 || target > grant.signupCredits + unlockCredits)
          throw new Error('Invalid unlock entitlement');
      }
      const amount = Math.max(0, target - grant.creditsReleased);
      if (expected !== 'pending_email' && amount === 0) return noGrant();
      // The target is account-wide, not reason-wide: competing validators cannot stack grants.
      // A drip is keyed by earning window, so each window pays once whatever else was released.
      const dripDay = typeof evidence === 'object' && 'drip' in evidence ? evidence.drip.day : undefined;
      const dripPeriod = typeof evidence === 'object' && 'drip' in evidence ? evidence.drip.period : undefined;
      const transactionId = dripDay
        ? `unlock-grant:activity:${userId}:${dripDay}${dripPeriod ? `:${dripPeriod}` : ''}`
        : expected === 'pending_email'
          ? `verify-grant:${userId}`
          : grant.creditsReleased === (assessment?.credits ?? grant.signupCredits)
            ? `unlock-grant:${userId}`
            : `unlock-grant:${userId}:${target}`;
      const existing = await db.creditTransactions.findOne({ transactionId });
      if (existing) {
        if (dripDay) return noGrant();
        throw new Error('Staged grant ledger and account state disagree');
      }
      let balance = user.currentCredits;
      let creditTransactionId: string | undefined;
      if (amount > 0) {
        if (!BUDGET_EXEMPT_REASONS.has(reason) && !adapters.bypassBudget) {
          // An account already in the queue is drained by the held-release cron in order; a new one waits behind it.
          // A drip likewise waits while it would leave the trickle pool unable to pay the oldest queued reward.
          const queued = dripDay
            ? await queueHeadBlocks(db, 'trickle', db.signupProtection?.grantBudget?.heldRewards, amount, dripDay)
            : expected === 'pending_email' &&
              user.signupGrantHeldReason !== 'budget_exhausted' &&
              (await hasSignupBacklog(db.users, signupGrantBudgetDay(grantClock(db))));
          const reservation = queued
            ? { outcome: 'exhausted' as const, release: async () => {} }
            : await reserveSignupGrantBudget(db, transactionId, amount, {
                pool: dripDay ? 'trickle' : 'signup',
                day: dripDay,
              });
          reservations.push(reservation);
          // A same-day drip that did not make the draw fresh belongs to a concurrent attempt that may
          // still refund it; paying on that reservation could pay unmetered.
          // A retried transaction re-reserves as a no-op, so an earlier attempt's fresh draw is still ours.
          if (dripDay && reservation.outcome === 'reserved' && !reservations.some(held => held.fresh)) return noGrant();
          if (reservation.outcome === 'exhausted') {
            // The tranche stays pending and tagged for the held-release job or a card/subscription unlock.
            if (expected === 'pending_email') {
              await db.users.addTagsToUser(userId, [PENDING_FREE_CREDITS_TAG]);
              await db.users.update({
                id: userId,
                signupGrantHeldReason: 'budget_exhausted',
                // Kept from the first hold so a retried account keeps its place in the queue.
                ...(user.signupGrantHeldReason === 'budget_exhausted' ? {} : { signupGrantHeldAt: grantClock(db) }),
              });
            }
            return { ...noGrant(), withheld: true, budgetExhausted: true };
          }
        }
        // Staged and legacy default grants share one canonical-inbox entitlement. Claim on
        // the first actual payout, including an unlock after a zero-valued signup tranche.
        // A duplicate claim may have aborted Mongo's transaction; throw out of it before
        // performing another operation, rather than trying to commit a denied claim.
        if (!(await db.users.claimFreeCreditGrant(userId))) throw new InboxGrantClaimDeniedError();
        const result = await addCreditsWithLedgerRow(
          {
            ownerId: userId,
            ownerType: CreditHolderType.User,
            credits: amount,
            type: 'generic_add',
            transactionId,
            reason: reason ? `signup_unlock:${reason}` : 'signup_tranche',
            description: reason ? `Signup credits unlocked: ${SIGNUP_UNLOCK_DESCRIPTIONS[reason]}` : 'Signup credits',
          },
          {
            db: { creditTransactions: db.creditTransactions, creditLots: db.creditLots },
            creditHolderMethods: db.users,
            duplicateTransactionId: 'throw',
          }
        );
        balance = result.creditHolder.currentCredits;
        creditTransactionId = result.creditTransactionId;
      }
      const released = grant.creditsReleased + amount;
      const unlocked = released >= grant.signupCredits + unlockCredits && dripRemainingAfter <= 0;
      const nextGrant: SignupGrant = {
        ...(unlocked ? withoutHeldUnlock(grant) : grant),
        stage: unlocked ? 'unlocked' : 'signup',
        creditsReleased: released,
        nextCondition: unlocked ? null : 'verification',
        ...(reason ? { unlockedBy: reason } : {}),
        unlockCredits,
        ...(dripDay ? { dripCredits: (grant.dripCredits ?? 0) + dripAmount, lastDripDay: dripDay } : {}),
        ...(dripPeriod ? { lastDripPeriod: dripPeriod } : {}),
        ...(typeof evidence === 'object' && 'unlockedOrgId' in evidence
          ? { unlockedOrgId: evidence.unlockedOrgId }
          : {}),
      };
      // A held tranche is released only from the admin risk review queue, and not every caller rescores
      // after this (refreshSignupRiskScore), so queue it here. An admin decision already taken stands.
      const enterRiskReview =
        !!assessedBand &&
        isSignupGrantHeldForReview({ signupGrant: nextGrant, signupGrantAssessment: assessment }) &&
        (user.riskScore?.reviewState ?? 'none') === 'none';
      // An unlock that pays the held tranche (card, subscription, ...) ends the hold, so an account queued
      // only for it leaves the queue. An admin release is approved by its caller (admin/signup-risk-reviews).
      const leaveRiskReview =
        reason !== 'admin' &&
        user.riskScore?.reviewState === 'pending' &&
        isSignupGrantHeldForReview(user) &&
        !isSignupGrantHeldForReview({ signupGrant: nextGrant, signupGrantAssessment: assessment }) &&
        !(await scoreNeedsReview(user.riskScore.score, db.adminSettings));
      const updated = await db.users.update({
        id: userId,
        ...(assessment ? { signupGrantAssessment: assessment } : {}),
        ...(user.signupGrantHeldReason ? { signupGrantHeldReason: null } : {}),
        ...(enterRiskReview
          ? {
              riskScore: {
                score: 0,
                signals: [],
                computedAt: new Date(),
                ...user.riskScore,
                reviewState: 'pending' as const,
              },
            }
          : {}),
        ...(leaveRiskReview && user.riskScore
          ? { riskScore: { ...user.riskScore, reviewState: 'none' as const } }
          : {}),
        signupGrant: nextGrant,
      });
      if (!updated) throw new Error('Staged grant account update failed');
      await audit?.({ userId, credits: amount, creditTransactionId });
      return { creditsGranted: amount, currentCredits: balance, assessedBand };
    });
    const { assessedBand, ...grantResult } = result;
    if (result.creditsGranted === 0) await releaseReservations();
    if (assessedBand && adapters.emitRiskBand) {
      try {
        await adapters.emitRiskBand(assessedBand);
      } catch {
        console.warn('[signup-risk] Band telemetry failed after grant commit');
      }
    }
    return grantResult;
  } catch (error) {
    // The counter sits outside the payout transaction, so an aborted payout must hand its draw back.
    // A duplicate ledger row means a concurrent release paid under this id: its draw stays spent.
    if (!(error instanceof DuplicateCreditTransactionError)) await releaseReservations();
    if (!(error instanceof DuplicateCreditTransactionError) && !(error instanceof InboxGrantClaimDeniedError))
      throw error;
    // Paid elsewhere, or never payable to this inbox: either way the tranche is no longer held.
    await clearHeldReason(db.users, userId);
    return noGrant();
  }
}

/**
 * A grant withheld for signup domain review is no longer waiting on the signup pool. Its budget hold
 * would keep it in the held-release cron's scan and count as signup backlog (hasSignupBacklog) for as
 * long as the review stays open, queueing every new grant behind it. It stays tagged, so the admin
 * domain release (apps/client/pages/api/admin/signup-domain-holds.ts) still pays it.
 */
export async function dropBudgetHold(
  users: FreeCreditAdapters['db']['users'],
  userId: string,
  heldReason: string | null | undefined
) {
  if (heldReason === 'budget_exhausted') await users.update({ id: userId, signupGrantHeldReason: null });
}

async function clearHeldReason(users: FreeCreditAdapters['db']['users'], userId: string) {
  if ((await users.findById(userId))?.signupGrantHeldReason)
    await users.update({ id: userId, signupGrantHeldReason: null });
}

/**
 * True when a payable grant (staged tranche or flat-path grant) held for the signup pool before `day` is
 * still waiting. New grants then hold behind it so the held-release cron pays the queue oldest first.
 * Blocked holders never count.
 */
export async function hasSignupBacklog(users: FreeCreditAdapters['db']['users'], day: string): Promise<boolean> {
  const held = await users.findOne({
    // $type repeats the user_signupGrantHeldReason partial filter so the planner can use that index.
    signupGrantHeldReason: { $eq: 'budget_exhausted', $type: 'string' },
    // Same payable set the held-release cron drains (SignupGrantReleaseBatchModel listHeld payableOnly):
    // a hold that cron never pays would otherwise queue every new grant behind it indefinitely.
    tags: PENDING_FREE_CREDITS_TAG,
    emailVerified: true,
    isBanned: { $ne: true },
    isModerated: { $ne: true },
    disputePending: { $ne: true },
    'moderation.status': { $ne: 'suspended' },
    'signupGrant.blocked': { $exists: false },
    deletedAt: { $exists: false },
    signupGrantHeldAt: { $lt: new Date(`${day}T00:00:00.000Z`) },
  });
  return !!held;
}

export const releaseSignupTranche = (userId: string, adapters: GrantAdapters) =>
  releaseStage(
    userId,
    'pending_email',
    undefined,
    async user => {
      if (!user.emailVerified) throw new Error('Email verification required for signup grant');
      return true;
    },
    adapters
  );

type UnlockAdapters = GrantAdapters & {
  validators: Partial<Record<SignupGrantUnlockReason, SignupGrantValidator>>;
  /** Held-release job only: pays a payment unlock whose hold has reached `releaseAt` by this time. */
  releaseHeldUnlockAt?: Date;
};

/**
 * Validators are server-owned integrations, never request payloads. Missing integrations fail closed.
 * A payment unlock (card or subscription) is held for `signupUnlockPaymentHoldHours` so a stolen card
 * cannot cash out the remainder before its dispute or early fraud warning arrives.
 */
export const unlockSignupGrant = (userId: string, reason: SignupGrantUnlockReason, adapters: UnlockAdapters) => {
  const validator = adapters.validators[reason];
  if (!validator || (reason === 'admin' && !adapters.audit)) return Promise.resolve(noGrant());
  if (!isPaymentUnlockReason(reason))
    return releaseStage(
      userId,
      'signup',
      reason,
      async user => (user.emailVerified ? validator(user) : false),
      adapters
    );
  const releaseAt = adapters.releaseHeldUnlockAt;
  const paymentValidator: SignupGrantValidator = async user => {
    const grant = user.signupGrant;
    if (!user.emailVerified || !grant || grant.unlockForfeited) return false;
    if (releaseAt && !(grant.heldUnlock && new Date(grant.heldUnlock.releaseAt) <= releaseAt)) return false;
    return validator(user);
  };
  const unlock = async () => {
    if (releaseAt || (await resolvePaymentUnlockHoldHours(adapters.db.adminSettings)) === 0)
      return releaseStage(userId, 'signup', reason, paymentValidator, adapters);
    return holdPaymentUnlock(userId, reason, paymentValidator, adapters);
  };
  return unlockWithHeldTranche(userId, adapters, paymentValidator, unlock);
};

export async function resolvePaymentUnlockHoldHours(adminSettings: GrantAdapters['db']['adminSettings']) {
  const { schema, defaultValue } = settingsMap.signupUnlockPaymentHoldHours;
  const parsed = schema.safeParse(
    (await adminSettings.findBySettingName('signupUnlockPaymentHoldHours'))?.settingValue
  );
  // A missing or invalid setting holds rather than pays.
  return parsed.success ? parsed.data : (defaultValue ?? 72);
}

/**
 * Records the payment unlock as held instead of paying it. Repeat payments keep the first payment's
 * release time, so renewals cannot push it out and a fresh card cannot pull it in.
 */
async function holdPaymentUnlock(
  userId: string,
  reason: PaymentUnlockReason,
  validate: SignupGrantValidator,
  adapters: GrantAdapters
): Promise<GrantFreeCreditsResult> {
  const { db } = adapters;
  // Same domain protection as a payout, so a protected account records no hold either.
  if (db.signupProtection && (await protectSignupCredits(userId, db))) return { ...noGrant(), withheld: true };
  const hours = await resolvePaymentUnlockHoldHours(db.adminSettings);
  const { dripCap } = await resolveDripLimits(db.adminSettings);
  const releaseAt = await withTransaction<Date | null>(async () => {
    const user = await db.users.findById(userId);
    if (!isReleaseEligible(user, 'signup') || signupGrantRemaining(user.signupGrant, dripCap) === 0) return null;
    if (user.signupGrant.heldUnlock) return user.signupGrant.heldUnlock.releaseAt;
    if (!(await validate(user))) return null;
    const heldAt = grantClock(db);
    const heldUnlock = { reason, heldAt, releaseAt: new Date(heldAt.getTime() + hours * 3_600_000) };
    const updated = await db.users.update({ id: userId, signupGrant: { ...user.signupGrant, heldUnlock } });
    if (!updated) throw new Error('Staged grant account update failed');
    return heldUnlock.releaseAt;
  });
  return releaseAt ? { ...noGrant(), withheld: true, heldUntil: new Date(releaseAt) } : noGrant();
}

/**
 * A card unlock on an account whose signup tranche is held for the budget pays the tranche under its
 * own verify-grant id, then the remainder, each once and outside the budget.
 */
async function unlockWithHeldTranche(
  userId: string,
  adapters: GrantAdapters,
  validate: SignupGrantValidator,
  unlock: () => Promise<GrantFreeCreditsResult>
): Promise<GrantFreeCreditsResult> {
  const { users } = adapters.db;
  const user = await users.findById(userId);
  if (user?.signupGrant?.stage !== 'pending_email' || user.signupGrantHeldReason !== 'budget_exhausted')
    return unlock();
  const tranche = await releaseStage(
    userId,
    'pending_email',
    undefined,
    async current => (current.emailVerified ? validate(current) : false),
    { ...adapters, bypassBudget: true }
  );
  const afterTranche = await users.findById(userId);
  if (afterTranche?.signupGrant?.stage === 'pending_email') return tranche;
  if (afterTranche?.signupGrantHeldReason) await users.update({ id: userId, signupGrantHeldReason: null });
  const remainder = await unlock();
  const creditsGranted = tranche.creditsGranted + remainder.creditsGranted;
  return { ...remainder, creditsGranted, currentCredits: remainder.currentCredits ?? tranche.currentCredits };
}

let unsetDripCapAlertDay: string | undefined;
let unsetDripCapAlertInFlight = false;

/**
 * Fire-and-forget, at most once per UTC day per process (so once per warm Lambda container, not once globally):
 * the drip is paying from the registry default cap.
 * The day is marked only after a delivered alert, so a failed post retries on the next drip.
 */
function notifyUnsetDripCap(protection: GrantAdapters['db']['signupProtection'], fallback: number) {
  const today = new Date().toISOString().slice(0, 10);
  if (!protection?.notifyConfig || unsetDripCapAlertDay === today || unsetDripCapAlertInFlight) return;
  unsetDripCapAlertInFlight = true;
  protection
    .notifyConfig({ setting: 'signupGrantDripCap', fallback })
    .then(
      () => {
        unsetDripCapAlertDay = today;
      },
      error => {
        console.warn('[signup-grant] Unset drip cap alert failed', error);
      }
    )
    .finally(() => {
      unsetDripCapAlertInFlight = false;
    });
}

/** Test seam: clears the once-per-day alert dedupe. */
export function resetUnsetDripCapAlert() {
  unsetDripCapAlertDay = undefined;
  unsetDripCapAlertInFlight = false;
}

export type HeldUnlockReleaseResult = { scanned: number; released: number; creditsPaid: number; failed: number };

/**
 * Pays held payment unlocks whose settling window has passed. `listDueIds` returns only payable
 * accounts; a dispute flags the account and cancels the hold, so a disputed payment never pays here.
 */
export async function releaseDueHeldUnlocks(
  adapters: GrantAdapters & {
    listDueIds: (input: { now: Date; afterId?: string; limit: number }) => Promise<string[]>;
    logger: { error: (message: string, ...args: unknown[]) => void };
  },
  options: { now: Date; maxUsers: number; pageSize?: number }
): Promise<HeldUnlockReleaseResult> {
  const result: HeldUnlockReleaseResult = { scanned: 0, released: 0, creditsPaid: 0, failed: 0 };
  const pageSize = options.pageSize ?? 50;
  let afterId: string | undefined;
  while (result.scanned < options.maxUsers) {
    const ids = await adapters.listDueIds({
      now: options.now,
      afterId,
      limit: Math.min(pageSize, options.maxUsers - result.scanned),
    });
    if (!ids.length) break;
    for (const userId of ids) {
      result.scanned++;
      try {
        const reason = (await adapters.db.users.findById(userId))?.signupGrant?.heldUnlock?.reason;
        if (!reason) continue;
        const paid = await unlockSignupGrant(userId, reason, {
          ...adapters,
          validators: { [reason]: async (user: IUserDocument) => user.emailVerified },
          releaseHeldUnlockAt: options.now,
        });
        if (paid.creditsGranted > 0) {
          result.released++;
          result.creditsPaid += paid.creditsGranted;
        }
      } catch (error) {
        result.failed++;
        adapters.logger.error(`Held signup unlock release failed for user ${userId}`, error);
      }
    }
    afterId = ids[ids.length - 1];
  }
  return result;
}

export type ForfeitPaymentUnlockResult = {
  outcome: 'cancelled' | 'forfeited' | 'already_forfeited' | 'not_enrolled';
};

/**
 * Voids payment unlocks after a dispute, refund or early fraud warning on the account's payments:
 * cancels a held bonus before the held-release job can pay it, and closes payment unlocks for good.
 * A bonus already paid is left to the dispute clawback. Idempotent: a replay finds the marker.
 */
export async function forfeitPaymentUnlock(
  userId: string,
  cause: SignupUnlockForfeitCause,
  adapters: Pick<GrantAdapters, 'db'>
): Promise<ForfeitPaymentUnlockResult> {
  const { db } = adapters;
  return withTransaction<ForfeitPaymentUnlockResult>(async () => {
    const user = await db.users.findById(userId);
    const grant = user?.signupGrant;
    if (!grant) return { outcome: 'not_enrolled' };
    if (grant.unlockForfeited) return { outcome: 'already_forfeited' };
    const updated = await db.users.update({
      id: userId,
      signupGrant: { ...withoutHeldUnlock(grant), unlockForfeited: { cause, at: grantClock(db) } },
    });
    if (!updated) throw new Error('Staged grant account update failed');
    return { outcome: grant.heldUnlock ? 'cancelled' : 'forfeited' };
  });
}

export async function resolveDripLimits(adminSettings: GrantAdapters['db']['adminSettings']) {
  const { dailyCredits, dripCap, dripCapSource } = await resolveSignupGrantSchedule(adminSettings);
  return { dailyCredits, dripCap, dripCapSource };
}

/**
 * Pays a UTC day's activity drip, or a trusted preview period within it. The caller establishes eligibility; this owns
 * the rate, the cap, the once-per-day ledger id and the draw from the trickle pool. A dry trickle pool
 * skips the day (withheld, not queued); signup tranches held on the signup pool do not stop it. The pool is
 * shared with gear/referral rewards (creditService.payCreditReward), and a drip waits while it would leave
 * the pool unable to pay the oldest queued reward.
 */
export async function dripSignupGrant(
  userId: string,
  day: string,
  adapters: GrantAdapters,
  period?: string
): Promise<GrantFreeCreditsResult> {
  if (period !== undefined && !/^preview:\d{1,4}:\d+$/.test(period)) return noGrant();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return noGrant();
  const { dailyCredits, dripCap, dripCapSource } = await resolveDripLimits(adapters.db.adminSettings);
  if (!(dailyCredits > 0) || !(dripCap > 0)) return noGrant();
  if (dripCapSource === 'default') notifyUnsetDripCap(adapters.db.signupProtection, dripCap);
  const user = await adapters.db.users.findById(userId);
  if (!user?.signupGrant || hasPaidSignupDrip(user.signupGrant, day, period)) return noGrant();
  return releaseStage(
    userId,
    'signup',
    'activity_drip',
    async current => (current.emailVerified ? { drip: { day, dailyCredits, dripCap, period } } : false),
    adapters
  );
}
