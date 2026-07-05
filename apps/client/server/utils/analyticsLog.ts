import { IUserDocument, WithOrgRef, IOrganizationDocument, ICounterLog } from '@bike4mind/common';
import { mongoose, Ability, User, UserActivityCounter, CounterLog } from '@bike4mind/database';
import { counterService } from '@bike4mind/services';
import { isValidEnumValue } from '@bike4mind/utils';
import { ANALYTICS_EVENTS, AnalyticsEventPayloads, AnalyticsEvents } from '@server/types/analytics';

/**
 * This is a generic function to log an event to the database.
 */
export async function logEvent(
  event: AnalyticsEventPayloads,
  options?: {
    session?: mongoose.ClientSession;
    ability?: Ability;
  }
): Promise<void> {
  // No transaction wrapping: UserActivityCounter.updateOne ($inc upsert) and CounterLog.create
  // are both single-document atomic operations that don't require multi-document transaction
  // guarantees for analytics data. Wrapping in withTransaction caused "transaction aborted"
  // errors (code 251) under concurrent Slack events for the same user.
  //
  // If called from within an existing withTransaction context, transactionAsyncLocalStorage
  // automatically propagates the ambient session to these writes. If called standalone,
  // they execute as independent atomic operations.
  await counterService.incrementUserCounter(
    event.userId!,
    { action: event.type, metadata: event.metadata, increment: event.counterValue },
    {
      db: {
        users: {
          findByIdWithOrganization: async (userId: string) => {
            const user = await User.findById(userId).populate<{ organizationId: IOrganizationDocument }>(
              'organizationId'
            );
            if (!user) return null;
            const userObj = user.toObject();
            return {
              ...userObj,
              organizationId: userObj.organizationId || { _id: '', name: '' },
            } as unknown as WithOrgRef<IUserDocument>;
          },
        },
        userActivityCounters: {
          upsertByUserIdAndAction: async (
            userId: string,
            action: string,
            data: Partial<counterService.AddUserCounterParameters>
          ) => {
            // Build update operations
            const updateOps: any = { $inc: { count: data.increment ?? 1 } };

            // For modal/banner-related actions, add modal ID to tags for tracking specific modals
            const isModalAction =
              action === 'Modal Viewed' || action === 'Modal Agreed To' || action === 'Banner Viewed';
            const modalId = data.metadata?.id;

            if (isModalAction && modalId && typeof modalId === 'string') {
              // Use $addToSet to add modal ID to tags array without duplicates
              updateOps.$addToSet = { tags: modalId };
            }

            // Note: Do NOT spread accessibleBy() into an upsert filter alongside explicit userId.
            // CASL's ownDocumentPermission adds { userId } which duplicates the explicit userId,
            // causing MongoDB error 54 "path 'userId' is matched twice" on insert (new users).
            const query = UserActivityCounter.updateOne(
              {
                userId,
                action,
              },
              updateOps,
              { upsert: true }
            );

            if (options?.session) {
              query.session(options.session);
            }

            return query;
          },
        },
        counterLogs: {
          create: async (counter: ICounterLog) =>
            await CounterLog.create([counter], options?.session ? { session: options.session } : {}).then(
              docs => docs[0]
            ),
        },
      },
      fn: {
        isValidCounterEvent: (event: string): event is AnalyticsEvents => {
          return isValidEnumValue(event, ANALYTICS_EVENTS);
        },
      },
    }
  );
}
