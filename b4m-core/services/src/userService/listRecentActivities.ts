import { z } from 'zod';
import { secureParameters } from '@bike4mind/utils';
import { IUserDocument, ICounterLogRepository } from '@bike4mind/common';
import { SessionEvents, FileEvents } from '@bike4mind/common';

const listRecentActivitiesSchema = z.object({
  coverage: z.enum(['all', 'important']).prefault('important'),
  userId: z.string().optional(),
});

type ListRecentActivitiesParameters = z.infer<typeof listRecentActivitiesSchema>;

interface ListRecentActivitiesAdapters {
  db: {
    counterLogs: ICounterLogRepository;
  };
}

// Counter names shown in the important-coverage feed
const IMPORTANT_COUNTER_NAMES = [
  SessionEvents.CREATE_SESSION,
  SessionEvents.UPDATE_SESSION,
  SessionEvents.DELETE_SESSION,
  SessionEvents.CLONE_SESSION,
  FileEvents.CREATE_FILE,
  FileEvents.DELETE_FILE,
  FileEvents.UPDATE_FILE,
];

/**
 * List the 10 most recent activities for a user
 * @param user - The user to list activities for
 * @param params - Parameters to filter activities
 * @param adapters - The adapters to use
 * @returns The 10 most recent activities for the user
 */
export const listRecentActivities = async (
  user: IUserDocument,
  params: ListRecentActivitiesParameters,
  adapters: ListRecentActivitiesAdapters
) => {
  const { coverage, userId: targetUserId } = secureParameters(params, listRecentActivitiesSchema);

  const effectiveUserId = targetUserId || user.id;

  if (coverage === 'important') {
    return adapters.db.counterLogs.findRecentByUserIdAndCounterNamesAndHasMetadata(
      effectiveUserId,
      IMPORTANT_COUNTER_NAMES
    );
  }

  return adapters.db.counterLogs.findRecentByUserIdAndHasMetadata(effectiveUserId);
};
