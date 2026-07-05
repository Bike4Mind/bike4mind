import { baseApi } from '@server/middlewares/baseApi';
import { getNotificationDeduplicator } from '@bike4mind/utils';

const handler = baseApi({ auth: true }).get(async (req, res) => {
  console.log('🔍 DEBUG: Getting notification deduplicator status');

  try {
    const status = getNotificationDeduplicator().getStatus();

    console.log('📊 DEBUG: Current deduplicator status:', status);

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      status,
      description: {
        errorGroupsCount: 'Number of unique error types being tracked for deduplication',
        lowCreditUsersTracked: 'Number of users with low credit tier tracking active',
      },
      notes: [
        'Error groups are automatically cleaned up after 1 hour of inactivity',
        'Low credit tiers reset when user credits go above 1000',
        'Each user can have 3 tiers: 1000, 300, and 0 credits',
      ],
    });
  } catch (error) {
    console.error('❌ DEBUG: Error getting notification status:', error);
    res.status(500).json({
      error: 'Failed to get notification status',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
