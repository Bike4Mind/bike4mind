import {
  CreditHolderType,
  PENDING_FREE_CREDITS_TAG,
  settingsMap,
  type IUserDocument,
  type SignupGrant,
  type SignupGrantUnlockReason,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import { addCreditsWithLedgerRow, DuplicateCreditTransactionError } from '../creditService';
import type { FreeCreditAdapters, GrantFreeCreditsResult } from './freeCredits';
import { evaluateSignupRisk, signupRiskPolicySchema, type SignupRiskSignals } from './signupRisk';
import { accountBlockReasons, isAiAccessRevoked } from './accountState';
import { protectSignupCredits } from './signupProtection';
import { reserveSignupGrantBudget, type SignupGrantBudgetReservation } from './signupGrantBudget';

type GrantAdapters = FreeCreditAdapters & {
  audit?: (input: { userId: string; credits: number; creditTransactionId?: string }) => Promise<void>;
};

/** `unlockedOrgId` releases the full remainder and records the org that vouched for the account. */
export type SignupGrantValidator = (
  user: IUserDocument
) => Promise<boolean | { cumulativeCredits: number } | { unlockedOrgId: string }>;

/** One UTC day's activity drip: a fixed daily amount, bounded by the account-wide drip cap. */
type DripEvidence = { drip: { day: string; dailyCredits: number; maxCredits: number } };

const noGrant = (): GrantFreeCreditsResult => ({ creditsGranted: 0, currentCredits: null });

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
    const result = await withTransaction(async () => {
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
          if (assessment.status === 'unavailable') {
            console.warn('[signup-risk] Assessment unavailable; holding signup grant');
          }
        }
        target = assessment.credits;
        if (!Number.isSafeInteger(target) || target < 0 || target > grant.signupCredits)
          throw new Error('Invalid signup assessment entitlement');
      } else {
        if (typeof evidence === 'object' && 'drip' in evidence) {
          const { day, dailyCredits, maxCredits } = evidence.drip;
          const dripped = grant.dripCredits ?? 0;
          if (grant.lastDripDay === day || !Number.isSafeInteger(dripped) || dripped < 0) return noGrant();
          dripAmount = Math.max(0, Math.min(dailyCredits, maxCredits - dripped, maximum - grant.creditsReleased));
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
      // A drip is keyed by UTC day instead, so each day pays at most once whatever else was released.
      const dripDay = typeof evidence === 'object' && 'drip' in evidence ? evidence.drip.day : undefined;
      const transactionId = dripDay
        ? `unlock-grant:activity:${userId}:${dripDay}`
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
            // The tranche stays pending (and tagged) until a card or subscription unlock pays it; nothing retries it on a schedule.
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
      const updated = await db.users.update({
        id: userId,
        ...(assessment ? { signupGrantAssessment: assessment } : {}),
        ...(user.signupGrantHeldReason ? { signupGrantHeldReason: null } : {}),
        signupGrant: {
          ...grant,
          stage: unlocked ? 'unlocked' : 'signup',
          creditsReleased: released,
          nextCondition: unlocked ? null : 'verification',
          ...(reason ? { unlockedBy: reason } : {}),
          ...(dripDay ? { dripCredits: (grant.dripCredits ?? 0) + dripAmount, lastDripDay: dripDay } : {}),
          ...(typeof evidence === 'object' && 'unlockedOrgId' in evidence
            ? { unlockedOrgId: evidence.unlockedOrgId }
            : {}),
        },
      });
      if (!updated) throw new Error('Staged grant account update failed');
      await audit?.({ userId, credits: amount, creditTransactionId });
      return { creditsGranted: amount, currentCredits: balance };
    });
    if (result.creditsGranted === 0) await releaseReservations();
    return result;
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
  return unlockWithHeldTranche(userId, adapters, unlock);
};

/**
 * A card unlock on an account whose signup tranche is held for the budget pays the tranche under its
 * own verify-grant id, then the remainder, each once and outside the budget.
 */
async function unlockWithHeldTranche(
  userId: string,
  adapters: GrantAdapters,
  unlock: () => Promise<GrantFreeCreditsResult>
): Promise<GrantFreeCreditsResult> {
  const { users } = adapters.db;
  const user = await users.findById(userId);
  if (user?.signupGrant?.stage !== 'pending_email' || user.signupGrantHeldReason !== 'budget_exhausted')
    return unlock();
  const tranche = await releaseSignupTranche(userId, { ...adapters, bypassBudget: true });
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
 * Pays one UTC day's activity drip. The caller has already established that `day` qualifies; this owns
 * the rate, the cap, the once-per-day ledger id and the daily budget draw. Signup tranches still held
 * for the budget are paid first, so a drip is skipped (withheld) while a live one from `day` exists.
 */
export async function dripSignupGrant(
  userId: string,
  day: string,
  adapters: GrantAdapters
): Promise<GrantFreeCreditsResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return noGrant();
  const { dailyCredits, maxCredits } = await resolveDripLimits(adapters.db.adminSettings);
  if (!(dailyCredits > 0) || !(maxCredits > 0)) return noGrant();
  const user = await adapters.db.users.findById(userId);
  if (!user?.signupGrant || user.signupGrant.lastDripDay === day) return noGrant();
  // Existence only, and bounded: holders that are blocked, AI-revoked or held before `day` are ignored
  // so one abandoned hold cannot stall every drip. Nothing retries a hold, so only today's holds count.
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
    async current => (current.emailVerified ? { drip: { day, dailyCredits, maxCredits } } : false),
    adapters
  );
}
