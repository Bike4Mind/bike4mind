import { CreditHolderType } from '@bike4mind/common';
import {
  claimCreditGrantIdentity,
  creditTransactionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import { CardVerification } from './cardVerificationModel';

export function cardVerificationTransactionId(userId: string): string {
  return `unlock-grant:card_verified:${userId}`;
}

export async function grantVerifiedCardCredits(
  verificationId: string,
  userId: string,
  eligible: (userId: string) => Promise<boolean>
): Promise<'granted' | 'already_granted' | 'refused'> {
  const record = await CardVerification.findOne({ verificationId, userId }).lean();
  if (!record || !['verified', 'granted'].includes(record.state) || !record.identityDigest)
    throw new Error('Card verification has not been approved');
  if (!Number.isSafeInteger(record.credits) || record.credits <= 0) throw new Error('Invalid verification entitlement');
  if (!(await eligible(userId))) throw new Error('Account is not eligible for a verification grant');
  const transactionId = cardVerificationTransactionId(userId);
  if (!(await claimCreditGrantIdentity({ identityDigest: record.identityDigest, ownerId: userId, transactionId }))) {
    await CardVerification.updateOne({ verificationId, state: 'verified' }, { $set: { state: 'refused' } });
    return 'refused';
  }
  return withTransaction(
    async () => {
      const current = await CardVerification.findOne({ verificationId, userId }).lean();
      if (!current || !['verified', 'granted'].includes(current.state)) throw new Error('Verification state changed');
      const existing = await creditTransactionRepository.findOne({ transactionId });
      if (existing) {
        if (existing.ownerId !== userId || existing.metadata?.verificationId !== verificationId) {
          await CardVerification.updateOne({ verificationId, state: 'verified' }, { $set: { state: 'refused' } });
          return 'refused' as const;
        }
        return 'already_granted' as const;
      }
      if (!(await eligible(userId))) throw new Error('Account is not eligible for a verification grant');
      await creditService.addCreditsWithLedgerRow(
        {
          type: 'generic_add',
          ownerId: userId,
          ownerType: CreditHolderType.User,
          credits: current.credits,
          transactionId,
          reason: 'card_verified',
          metadata: { verificationId },
        },
        {
          db: { creditTransactions: creditTransactionRepository },
          creditHolderMethods: userRepository,
          duplicateTransactionId: 'throw',
        }
      );
      await CardVerification.updateOne({ verificationId, state: 'verified' }, { $set: { state: 'granted' } });
      return 'granted' as const;
    },
    { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
  );
}
