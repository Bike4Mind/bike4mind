import { z } from 'zod';
import { transactionSchema } from './schemas';

/**
 * Client-specific payment types and schemas.
 * Other deployments may use different payment payloads and plans.
 */

export enum CreditPackageId {
  A = 'package_10k',
  B = 'package_25k',
  C = 'package_50k',
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
