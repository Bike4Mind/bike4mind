import { z } from 'zod';

export const FULFILLMENT_STATES = ['consistent', 'unmatched', 'duplicate', 'reversal', 'pending', 'unknown'] as const;
export const PaymentFulfillmentQuery = z
  .object({
    source: z.enum(['payments', 'invoices']).default('payments'),
    days: z.coerce.number().int().min(1).max(90).default(7),
    cursor: z
      .string()
      .regex(/^(pi|in)_[A-Za-z0-9]+$/)
      .max(100)
      .optional(),
    state: z.enum(FULFILLMENT_STATES).optional(),
    ownerType: z.enum(['User', 'Organization']).optional(),
    limit: z.coerce.number().int().min(1).max(25).default(10),
  })
  .refine(query => !query.cursor || query.cursor.startsWith(query.source === 'invoices' ? 'in_' : 'pi_'), {
    message: 'Cursor must match the evidence source',
    path: ['cursor'],
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
  stripePaymentIntentId?: string;
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
  invoice?: {
    id: string;
    subscriptionId: string;
    subscriptionRecordId: string | null;
    billingReason: string | null;
    paymentIntentIds: string[];
    expectsGrant: boolean;
  };
};
export type FulfillmentFinding = FulfillmentEvidence & { state: FulfillmentState; explanation: string };
export function fulfillmentCounts(items: readonly FulfillmentFinding[]): Record<FulfillmentState, number> {
  return Object.fromEntries(
    FULFILLMENT_STATES.map(state => [state, items.filter(item => item.state === state).length])
  ) as Record<FulfillmentState, number>;
}
export type PaymentFulfillmentPage = {
  availability: 'available' | 'unavailable';
  checkedAt: string;
  from: string;
  nextCursor: string | null;
  scanned: number;
  items: FulfillmentFinding[];
};
