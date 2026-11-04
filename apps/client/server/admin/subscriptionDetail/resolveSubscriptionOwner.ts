import { organizationRepository, userRepository } from '@bike4mind/database';
import { SubscriptionOwnerType, type ISubscription } from '@bike4mind/server-utils/lib/subscriptions/types';
import type { recordAdminActionFromRequest } from '@server/utils/adminAudit';

type AuditTarget = Parameters<typeof recordAdminActionFromRequest>[1]['target'];

export type SubscriptionOwnerContext = {
  target: AuditTarget;
  organizationId?: string;
  notifyUserId: string | null;
  actingUserId: string | null;
};

/** The audit target and the user ids a subscription admin action notifies, for its owner. */
export const resolveSubscriptionOwner = async (subscription: ISubscription): Promise<SubscriptionOwnerContext> => {
  if (subscription.ownerType === SubscriptionOwnerType.User) {
    const user = await userRepository.findById(subscription.ownerId);
    return {
      target: {
        kind: 'user',
        id: subscription.ownerId,
        displayName: user?.email ?? user?.username ?? subscription.ownerId,
      },
      notifyUserId: subscription.ownerId,
      actingUserId: subscription.ownerId,
    };
  }
  const organization = await organizationRepository.findById(subscription.ownerId);
  return {
    target: {
      kind: 'organization',
      id: subscription.ownerId,
      displayName: organization?.name ?? subscription.ownerId,
    },
    organizationId: subscription.ownerId,
    notifyUserId: organization?.userId ?? null,
    actingUserId: organization?.userId ?? null,
  };
};
