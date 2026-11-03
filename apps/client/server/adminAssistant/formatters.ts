import { resolveSubscriptionSource, type ISubscription } from '@bike4mind/server-utils/lib/subscriptions/types';
import { SUBSCRIPTION_PLANS, TEAM_PLAN } from '@client/lib/userSubscriptions/constants';

export type OrgRole = 'owner' | 'admin' | 'member';

type OrgRoleSubject = { userId?: string; adminUserIds?: string[]; users?: { userId: string }[] };

// Same admin rule as OrganizationModel.findIdsAdministeredBy: a manager id counts only with a member row.
export const orgRoleOf = (org: OrgRoleSubject, userId: string): OrgRole => {
  if (org.userId === userId) return 'owner';
  const isManager = org.adminUserIds?.includes(userId) === true;
  const isMember = org.users?.some(member => member.userId === userId) === true;
  return isManager && isMember ? 'admin' : 'member';
};

export const toIso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

// TEAM_PLAN is kept out of SUBSCRIPTION_PLANS, so org subscriptions resolve only through it; same
// list as adminSubscriptionsQuery's plan catalog.
const NAMED_PLANS = [...SUBSCRIPTION_PLANS, TEAM_PLAN];

// Plan names, never the Stripe price id.
const planNameOf = (priceId: string): string => NAMED_PLANS.find(plan => plan.priceId === priceId)?.name ?? 'unknown';

type SubscriptionSubject = Pick<ISubscription, 'priceId' | 'status' | 'periodEndsAt'> &
  Parameters<typeof resolveSubscriptionSource>[0];

export const toSubscriptionSummary = (subscription: SubscriptionSubject) => ({
  plan: planNameOf(subscription.priceId),
  status: subscription.status,
  source: resolveSubscriptionSource(subscription),
  periodEndsAt: toIso(subscription.periodEndsAt),
});
