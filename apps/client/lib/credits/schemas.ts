import { z } from 'zod';
import { CreditPackageId, TransactionType } from './types';

const baseTransactionSchema = z.object({
  transactionType: z.enum(TransactionType),
});
export const perCreditSchema = baseTransactionSchema.extend({
  transactionType: z.literal(TransactionType.PerCredit),
  credits: z.number(),
});
export const packageSchema = baseTransactionSchema.extend({
  transactionType: z.literal(TransactionType.Package),
  packageId: z.enum(CreditPackageId),
});

export const transactionSchema = z.discriminatedUnion('transactionType', [perCreditSchema, packageSchema]);
