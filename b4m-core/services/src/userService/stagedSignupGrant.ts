import {
  CreditHolderType,
  type IUserDocument,
  type SignupGrant,
  type SignupGrantUnlockReason,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import { addCreditsWithLedgerRow, DuplicateCreditTransactionError } from '../creditService';
import type { FreeCreditAdapters, GrantFreeCreditsResult } from './freeCredits';
import { evaluateSignupRisk, type SignupRiskSignals } from './signupRisk';
import { accountBlockReasons, isAiAccessRevoked } from './accountState';

type GrantAdapters = FreeCreditAdapters & {
  audit?: (input: { userId: string; credits: number; creditTransactionId?: string }) => Promise<void>;
  collectRiskSignals?: (user: IUserDocument) => Promise<SignupRiskSignals>;
};

export type SignupGrantValidator = (user: IUserDocument) => Promise<boolean | { cumulativeCredits: number }>;

const noGrant = (): GrantFreeCreditsResult => ({ creditsGranted: 0, currentCredits: null });

async function releaseStage(
  userId: string,
  expected: SignupGrant['stage'],
  reason: SignupGrantUnlockReason | undefined,
  validate: SignupGrantValidator,
  adapters: GrantAdapters
): Promise<GrantFreeCreditsResult> {
  const { db, audit } = adapters;
  try {
    return await withTransaction(async () => {
      const user = await db.users.findById(userId);
      const grant = user?.signupGrant;
      if (
        !user ||
        !grant ||
        accountBlockReasons(user).length ||
        isAiAccessRevoked(user) ||
        (expected === 'pending_email' ? grant.stage !== expected : grant.stage === 'pending_email')
      )
        return noGrant();
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
            if (adapters.collectRiskSignals) signals = await adapters.collectRiskSignals(user);
          } catch {
            policy = undefined;
          }
          assessment = evaluateSignupRisk(policy, signals, grant.signupCredits);
        }
        target = assessment.credits;
        if (!Number.isSafeInteger(target) || target < 0 || target > grant.signupCredits)
          throw new Error('Invalid signup assessment entitlement');
      } else {
        target = evidence === true ? maximum : evidence.cumulativeCredits;
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
        signupGrant: {
          ...grant,
          stage: unlocked ? 'unlocked' : 'signup',
          creditsReleased: released,
          nextCondition: unlocked ? null : 'verification',
          ...(reason ? { unlockedBy: reason } : {}),
        },
      });
      if (!updated) throw new Error('Staged grant account update failed');
      await audit?.({ userId, credits: amount, creditTransactionId });
      return { creditsGranted: amount, currentCredits: balance };
    });
  } catch (error) {
    if (!(error instanceof DuplicateCreditTransactionError)) throw error;
    return noGrant();
  }
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
  return releaseStage(userId, 'signup', reason, async user => (user.emailVerified ? validator(user) : false), adapters);
};
