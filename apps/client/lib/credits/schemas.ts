import { z } from 'zod';
import { CreditPackageId, TransactionType } from './types';

const baseTransactionSchema = z.object({
  transactionType: z.enum(TransactionType),
});
export const perCreditSchema = baseTransactionSchema.extend({
  transactionType: z.literal(TransactionType.PerCredit),
  // Now that pay-as-you-go credits are reachable without a subscription, bound the
  // requested amount: a positive integer with a sane cap, so arbitrary/zero/negative
  // values never reach Stripe.
  credits: z.number().int().positive().max(1_000_000),
});
export const packageSchema = baseTransactionSchema.extend({
  transactionType: z.literal(TransactionType.Package),
  packageId: z.enum(CreditPackageId),
});

export const transactionSchema = z.discriminatedUnion('transactionType', [perCreditSchema, packageSchema]);
