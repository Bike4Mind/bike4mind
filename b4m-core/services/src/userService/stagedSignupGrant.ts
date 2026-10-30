import {
  CreditHolderType,
  hasPaidSignupDrip,
  PENDING_FREE_CREDITS_TAG,
  settingsMap,
  type IUserDocument,
  type SignupGrant,
  type SignupGrantUnlockReason,
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
import { reserveSignupGrantBudget, type SignupGrantBudgetReservation } from './signupGrantBudget';

type GrantAdapters = FreeCreditAdapters & {
  audit?: (input: { userId: string; credits: number; creditTransactionId?: string }) => Promise<void>;
};

type AssessedGrantResult = GrantFreeCreditsResult & { assessedBand?: SignupRiskBand };

/** `unlockedOrgId` releases the full remainder and records the org that vouched for the account. */
export type SignupGrantValidator = (
  user: IUserDocument
) => Promise<boolean | { cumulativeCredits: number } | { unlockedOrgId: string }>;

/** One UTC day's activity drip: a fixed daily amount, bounded by the account-wide drip cap. */
type DripEvidence = { drip: { day: string; dailyCredits: number; maxCredits: number; period?: string } };

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
  if (expected === 'pending_email') return user.signupGrant.stage === expected;
  // An unpaid tranche blocks every unlock; unlockSignupGrant pays a held tranche first on a card or subscription unlock.
  return user.signupGrant.stage !== 'pending_email';
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
    if (!isReleaseEligible(user, expected)) return noGrant();
    if (!user.emailVerified) {
      if (expected === 'pending_email') throw new Error('Email verification required for signup grant');
      return noGrant();
    }
    // Detection may notify reviewers; keep it outside the retried payout transaction.
    if (await protectSignupCredits(userId, db)) {
      if (expected === 'pending_email') await db.users.addTagsToUser(userId, [PENDING_FREE_CREDITS_TAG]);
      return { ...noGrant(), withheld: true };
    }
  }
  // A re-run of the payout transaction re-reserves as a no-op, so every attempt's hold is kept for the refund.
  const reservations: SignupGrantBudgetReservation[] = [];
  const releaseReservations = () => Promise.all(reservations.map(held => held.release()));
  try {
    const result = await withTransaction<AssessedGrantResult>(async () => {
      const user = await db.users.findById(userId);
      if (!isReleaseEligible(user, expected)) return noGrant();
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
          const { day, dailyCredits, maxCredits, period } = evidence.drip;
          const dripped = grant.dripCredits ?? 0;
          if (hasPaidSignupDrip(grant, day, period) || !Number.isSafeInteger(dripped) || dripped < 0) return noGrant();
          dripAmount = Math.max(
            0,
            Math.min(dailyCredits, maxCredits - dripped, grant.unlockCredits - dripped, maximum - grant.creditsReleased)
          );
          target = grant.creditsReleased + dripAmount;
        } else {
          target = evidence === true || 'unlockedOrgId' in evidence ? maximum : evidence.cumulativeCredits;
        }
        if (!Number.isSafeInteger(target) || target < 0 || target > maximum)
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
          const reservation = await reserveSignupGrantBudget(db, transactionId, amount, dripDay);
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
                signupGrantHeldAt: db.signupProtection?.grantBudget?.now?.() ?? new Date(),
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
      const unlocked = released >= maximum;
      const nextGrant: SignupGrant = {
        ...grant,
        stage: unlocked ? 'unlocked' : 'signup',
        creditsReleased: released,
        nextCondition: unlocked ? null : 'verification',
        ...(reason ? { unlockedBy: reason } : {}),
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

async function clearHeldReason(users: FreeCreditAdapters['db']['users'], userId: string) {
  if ((await users.findById(userId))?.signupGrantHeldReason)
    await users.update({ id: userId, signupGrantHeldReason: null });
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

/** Validators are server-owned integrations, never request payloads. Missing integrations fail closed. */
export const unlockSignupGrant = (
  userId: string,
  reason: SignupGrantUnlockReason,
  adapters: GrantAdapters & { validators: Partial<Record<SignupGrantUnlockReason, SignupGrantValidator>> }
) => {
  const validator = adapters.validators[reason];
  if (!validator || (reason === 'admin' && !adapters.audit)) return Promise.resolve(noGrant());
  const unlock = () =>
    releaseStage(userId, 'signup', reason, async user => (user.emailVerified ? validator(user) : false), adapters);
  if (reason !== 'card_verified' && reason !== 'subscription') return unlock();
  return unlockWithHeldTranche(userId, adapters, validator, unlock);
};

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

export async function resolveDripLimits(adminSettings: GrantAdapters['db']['adminSettings']) {
  const read = async (key: 'signupGrantActivityDailyCredits' | 'signupGrantActivityMaxCredits') => {
    const parsed = settingsMap[key].schema.safeParse((await adminSettings.findBySettingName(key))?.settingValue);
    return parsed.success ? parsed.data : 0;
  };
  return {
    dailyCredits: await read('signupGrantActivityDailyCredits'),
    maxCredits: await read('signupGrantActivityMaxCredits'),
  };
}

/**
 * Pays a UTC day's activity drip, or a trusted preview period within it. The caller establishes eligibility; this owns
 * the rate, the cap, the once-per-day ledger id and the daily budget draw. Signup tranches still held
 * for the budget are paid first, so a drip is skipped (withheld) while a live one from `day` exists.
 */
export async function dripSignupGrant(
  userId: string,
  day: string,
  adapters: GrantAdapters,
  period?: string
): Promise<GrantFreeCreditsResult> {
  if (period !== undefined && !/^preview:\d{1,4}:\d+$/.test(period)) return noGrant();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return noGrant();
  const { dailyCredits, maxCredits } = await resolveDripLimits(adapters.db.adminSettings);
  if (!(dailyCredits > 0) || !(maxCredits > 0)) return noGrant();
  const user = await adapters.db.users.findById(userId);
  if (!user?.signupGrant || hasPaidSignupDrip(user.signupGrant, day, period)) return noGrant();
  // Existence only, and bounded: holders that are blocked, AI-revoked or held before `day` are ignored
  // so one abandoned hold cannot stall every drip. Older holds are retried by the held-release job.
  const heldTranche = await adapters.db.users.findOne({
    signupGrantHeldReason: 'budget_exhausted',
    'signupGrant.stage': 'pending_email',
    isBanned: { $ne: true },
    isModerated: { $ne: true },
    disputePending: { $ne: true },
    'moderation.status': { $ne: 'suspended' },
    deletedAt: { $exists: false },
    signupGrantHeldAt: { $gte: new Date(`${day}T00:00:00.000Z`) },
  });
  if (heldTranche) return { ...noGrant(), withheld: true };
  return releaseStage(
    userId,
    'signup',
    'activity_drip',
    async current => (current.emailVerified ? { drip: { day, dailyCredits, maxCredits, period } } : false),
    adapters
  );
}
