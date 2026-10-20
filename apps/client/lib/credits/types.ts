import { z } from 'zod';
import { transactionSchema } from './schemas';

/**
 * Client-specific payment types and schemas.
 * Other deployments may use different payment payloads and plans.
 */

// Ids are persisted on ledger rows and Stripe intents (and feed `credits-${packageId}` in
// payment-intent.ts), so never reuse a retired id for a different amount. 'package_25k' is the
// original id of the $20 pack and stays as is.
export enum CreditPackageId {
  Usd20 = 'package_25k',
  Usd50 = 'package_usd50',
  Usd100 = 'package_usd100',
}

export enum TransactionType {
  PerCredit = 'per_credit',
  Package = 'package',
}

export type PaymentPayload = z.infer<typeof transactionSchema>;

export type PaymentDetails = {
  /** Amount in cents. Stripe expects the amount in cents */
  amount: number;
  description: string;
  metadata: Record<string, string | number | null>;
};
