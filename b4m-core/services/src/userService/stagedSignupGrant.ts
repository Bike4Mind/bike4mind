import {
  CreditHolderType,
  type IUserDocument,
  type SignupGrant,
  type SignupGrantUnlockReason,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import { addCreditsWithLedgerRow, DuplicateCreditTransactionError } from '../creditService';
import type { FreeCreditAdapters, GrantFreeCreditsResult } from './freeCredits';

type GrantAdapters = FreeCreditAdapters & {
  audit?: (input: { userId: string; credits: number; creditTransactionId?: string }) => Promise<void>;
};

export type SignupGrantValidator = (user: IUserDocument) => Promise<boolean>;

const noGrant = (): GrantFreeCreditsResult => ({ creditsGranted: 0, currentCredits: null });

async function releaseStage(
  userId: string,
  expected: SignupGrant['stage'],
  reason: SignupGrantUnlockReason | undefined,
  validate: SignupGrantValidator,
  { db, audit }: GrantAdapters
): Promise<GrantFreeCreditsResult> {
  try {
    return await withTransaction(async () => {
      const user = await db.users.findById(userId);
      const grant = user?.signupGrant;
      if (!user || !grant || grant.stage !== expected || user.isBanned || !(await validate(user))) return noGrant();
      const amount = expected === 'pending_email' ? grant.signupCredits : grant.unlockCredits;
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid staged grant amount');
      const transactionId = expected === 'pending_email' ? `verify-grant:${userId}` : `unlock-grant:${userId}`;
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
      const unlocked = expected === 'signup' || grant.unlockCredits === 0;
      const updated = await db.users.update({
        id: userId,
        signupGrant: {
          ...grant,
          stage: unlocked ? 'unlocked' : 'signup',
          creditsReleased: grant.creditsReleased + amount,
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
  return releaseStage(userId, 'signup', reason, async user => user.emailVerified && (await validator(user)), adapters);
};
