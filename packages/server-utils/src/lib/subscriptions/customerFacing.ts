import type { IMongoDocument } from '@bike4mind/common';
import type { ISubscription } from './types';

/**
 * The fields of a subscription row a customer-facing response may carry. A field added to the
 * model stays out of those responses until it is listed here.
 */
export const CUSTOMER_FACING_SUBSCRIPTION_FIELDS = [
  'id',
  'ownerId',
  'ownerType',
  'subscriptionId',
  'priceId',
  'status',
  'source',
  'canceledAt',
  'periodStartsAt',
  'periodEndsAt',
  'quantity',
  'customCreditsPerCycle',
  'unitAmount',
  'currency',
  'interval',
  'intervalCount',
  'cancelAtPeriodEnd',
  'cancelAt',
  'endedAt',
  'trialEndsAt',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof (ISubscription & IMongoDocument))[];

export type CustomerFacingSubscription = Pick<
  ISubscription & IMongoDocument,
  (typeof CUSTOMER_FACING_SUBSCRIPTION_FIELDS)[number]
>;

/** Copies only the allow-listed fields; ones absent on the row stay absent. */
export function toCustomerFacingSubscription(row: ISubscription & IMongoDocument): CustomerFacingSubscription {
  const source: Record<string, unknown> = { ...row };
  const picked: Record<string, unknown> = {};
  for (const field of CUSTOMER_FACING_SUBSCRIPTION_FIELDS) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked as CustomerFacingSubscription;
}
