import type { IUserDocument } from '@bike4mind/common';
import { FREE_QUEST_LIMIT_REACHED_ERROR_CODE } from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/utils';
import { getActiveSubscriptionsForOrganization, getActiveSubscriptionsForUser } from './activeSubscriptions';
import { SubscriptionOwnerType } from '../lib/subscriptions/types';
import { subscriptionRepository } from '../models/Subscription';

async function hasLapsedSubscription(user: IUserDocument): Promise<boolean> {
  if (user.serviceAccountOrganizationId) {
    return subscriptionRepository.hasLapsedSubscriptionsByOwners(SubscriptionOwnerType.Organization, [
      user.serviceAccountOrganizationId,
    ]);
  }
  if (await subscriptionRepository.hasLapsedSubscriptionsByOwners(SubscriptionOwnerType.User, [user.id])) return true;
  const orgIds = await organizationRepository.findPlanHolderOrgIds(user.id);
  return subscriptionRepository.hasLapsedSubscriptionsByOwners(SubscriptionOwnerType.Organization, orgIds);
}

export async function admitQuestStart(user: IUserDocument, startId: string): Promise<'subscriber' | 'free'> {
  const subscriptions = user.serviceAccountOrganizationId
    ? await getActiveSubscriptionsForOrganization(user.serviceAccountOrganizationId)
    : await getActiveSubscriptionsForUser(user.id, { strict: true });
  if (subscriptions.length > 0) return 'subscriber';

  if (await hasLapsedSubscription(user)) {
    throw new ForbiddenError(
      'An active subscription is required to start another Questmaster plan. Questmaster is included with every paid plan. You can still read and export existing quests, or turn QuestMaster off (enableQuestMaster=false) to continue chatting.',
      { errorCode: FREE_QUEST_LIMIT_REACHED_ERROR_CODE }
    );
  }

  // The same admission may cross invoke -> queue -> process more than once.
  if (await userRepository.claimFreeQuestStart(user.id, startId)) return 'free';
  throw new ForbiddenError(
    'Your free QuestMaster quest has already been started. Questmaster is included with every paid plan. Turn QuestMaster off (enableQuestMaster=false) to continue chatting, or subscribe to start another QuestMaster quest.',
    {
      errorCode: FREE_QUEST_LIMIT_REACHED_ERROR_CODE,
    }
  );
}

export async function releaseQuestStart(user: IUserDocument, startId: string): Promise<void> {
  await userRepository.releaseFreeQuestStart(user.id, startId);
}
