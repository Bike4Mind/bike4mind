import {
  CreditHolderType,
  PENDING_FREE_CREDITS_TAG,
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

const noGrant = (): GrantFreeCreditsResult => ({ creditsGranted: 0, currentCredits: null });

/** Card verification and admin releases are never throttled by the daily signup grant budget. */
const BUDGET_EXEMPT_REASONS: ReadonlySet<SignupGrantUnlockReason | undefined> = new Set(['card_verified', 'admin']);

class InboxGrantClaimDeniedError extends Error {}

function isReleaseEligible(
  user: IUserDocument | null | undefined,
  expected: SignupGrant['stage']
): user is IUserDocument & { signupGrant: SignupGrant } {
  if (!user?.signupGrant || accountBlockReasons(user).length || isAiAccessRevoked(user)) return false;
  if (expected === 'pending_email') return user.signupGrant.stage === expected;
  // An unpaid tranche blocks every unlock; unlockSignupGrant pays a held tranche before a card unlock.
  return user.signupGrant.stage !== 'pending_email';
}

async function releaseStage(
  userId: string,
  expected: SignupGrant['stage'],
  reason: SignupGrantUnlockReason | undefined,
  validate: SignupGrantValidator,
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
        target = evidence === true || 'unlockedOrgId' in evidence ? maximum : evidence.cumulativeCredits;
        if (!Number.isSafeInteger(target) || target < 0 || target > maximum)
          throw new Error('Invalid unlock entitlement');
      }
      const amount = Math.max(0, target - grant.creditsReleased);
      if (expected !== 'pending_email' && amount === 0) return noGrant();
      // The target is account-wide, not reason-wide: competing validators cannot stack grants.
      const transactionId =
        expected === 'pending_email'
          ? `verify-grant:${userId}`
          : grant.creditsReleased === (assessment?.credits ?? grant.signupCredits)
            ? `unlock-grant:${userId}`
            : `unlock-grant:${userId}:${target}`;
      const existing = await db.creditTransactions.findOne({ transactionId });
      if (existing) throw new Error('Staged grant ledger and account state disagree');
      let balance = user.currentCredits;
      let creditTransactionId: string | undefined;
      if (amount > 0) {
        if (!BUDGET_EXEMPT_REASONS.has(reason) && !adapters.bypassBudget) {
          const reservation = await reserveSignupGrantBudget(db, transactionId, amount);
          reservations.push(reservation);
          if (reservation.outcome === 'exhausted') {
            // The tranche stays pending (and tagged) so a later day or a card unlock can pay it.
            if (expected === 'pending_email') {
              await db.users.addTagsToUser(userId, [PENDING_FREE_CREDITS_TAG]);
              await db.users.update({ id: userId, signupGrantHeldReason: 'budget_exhausted' });
            }
            return { ...noGrant(), withheld: true };
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
  if (reason !== 'card_verified') return unlock();
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
