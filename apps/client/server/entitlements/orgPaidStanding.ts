import { organizationRepository } from '@bike4mind/database';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { holdsPaidStanding } from './paidStanding';

/**
 * Paid standing for an organization, by the same rule as an account (paidStanding.ts): an active paid
 * subscription the organization owns, or a credit purchase stamped on it. A read error propagates so
 * a caller deciding a payout fails closed.
 */
export async function isPayingOrganization(organizationId: string): Promise<boolean> {
  const organization = await organizationRepository.findById(organizationId);
  if (!organization) return false;
  const subscriptions = await subscriptionRepository.findActiveSubscriptionsByOwners(
    SubscriptionOwnerType.Organization,
    [organizationId]
  );
  return holdsPaidStanding({ lastCreditsPurchasedAt: organization.lastCreditsPurchasedAt }, subscriptions);
}
