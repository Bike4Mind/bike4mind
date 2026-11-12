import { z } from 'zod';

export const FULFILLMENT_STATES = ['consistent', 'unmatched', 'duplicate', 'reversal', 'pending', 'unknown'] as const;
export const PaymentFulfillmentQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  cursor: z
    .string()
    .regex(/^pi_[A-Za-z0-9]+$/)
    .max(100)
    .optional(),
  state: z.enum(FULFILLMENT_STATES).optional(),
  ownerType: z.enum(['User', 'Organization']).optional(),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});
export type FulfillmentState = (typeof FULFILLMENT_STATES)[number];
export type FulfillmentLedgerRow = {
  id: string;
  type: string;
  ownerId: string;
  ownerType: string;
  credits: number;
  createdAt: string;
  status?: string;
  stripeRefundId?: string;
  stripeDisputeId?: string;
  reversedAt?: string | null;
};
export type FulfillmentEvidence = {
  id: string;
  createdAt: string;
  settledAt: string | null;
  amount: number;
  currency: string;
  livemode: boolean;
  succeeded: boolean;
  expectedCredits: number | null;
  owner: { id: string; type: 'User' | 'Organization' } | null;
  product: 'credit_pack' | 'subscription' | 'unknown';
  rows: FulfillmentLedgerRow[];
  refunds: { id: string; amount: number; status: string | null; createdAt: string }[];
  dispute: { id: string; status: string; createdAt: string } | null;
  complete: boolean;
};
export type FulfillmentFinding = FulfillmentEvidence & { state: FulfillmentState; explanation: string };
export type PaymentFulfillmentPage = {
  availability: 'available' | 'unavailable';
  checkedAt: string;
  from: string;
  nextCursor: string | null;
  scanned: number;
  items: FulfillmentFinding[];
};
