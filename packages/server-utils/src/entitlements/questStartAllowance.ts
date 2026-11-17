import type { IUserDocument } from '@bike4mind/common';
import { FREE_QUEST_LIMIT_REACHED_ERROR_CODE } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/utils';
import { getActiveSubscriptionsForOrganization, getActiveSubscriptionsForUser } from './activeSubscriptions';

export async function admitQuestStart(user: IUserDocument, startId: string): Promise<'subscriber' | 'free'> {
  const subscriptions = user.serviceAccountOrganizationId
    ? await getActiveSubscriptionsForOrganization(user.serviceAccountOrganizationId)
    : await getActiveSubscriptionsForUser(user.id, { strict: true });
  if (subscriptions.length > 0) return 'subscriber';

  // The same admission may cross invoke -> queue -> process more than once.
  if (await userRepository.claimFreeQuestStart(user.id, startId)) return 'free';
  throw new ForbiddenError(
    'Your free QuestMaster quest has already been started. A subscription is required for another.',
    {
      errorCode: FREE_QUEST_LIMIT_REACHED_ERROR_CODE,
    }
  );
}
