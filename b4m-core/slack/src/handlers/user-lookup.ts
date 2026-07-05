import { Logger } from '@bike4mind/observability';
import { getSlackDb } from '../di/registry';

/**
 * Find a user by their Slack ID with timeout handling
 * @param slackUserId - The Slack user ID to search for
 * @returns User document if found, null otherwise
 */
export async function findUserBySlackId(slackUserId: string) {
  try {
    const { User } = getSlackDb();
    const user = await (User as any)
      .findOne({
        'slackSettings.slackUserId': slackUserId,
      })
      .maxTimeMS(5000); // 5 second timeout instead of default 10 seconds

    if (user) {
      // user found; nothing to do here
    } else {
      Logger.warn(`⚠️ Database query returned null for Slack ID: ${slackUserId}`);
    }

    return user;
  } catch (error) {
    Logger.error('💥 Database query failed:', {
      slackUserId,
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
    return null;
  }
}

/**
 * Handle unlinked Slack user by sending onboarding message
 * @param channel - Slack channel ID
 * @param slackUserId - Slack user ID
 * @param eventId - Slack event ID
 * @param messageTs - Message timestamp
 * @param slackBotToken - Slack bot token for API calls
 * @param threadTs - Thread timestamp (optional, for threaded replies)
 * @param sendSlackMessage - Function to send Slack messages
 */
export async function handleUnlinkedUser(
  channel: string,
  slackUserId: string,
  eventId: string,
  messageTs: string,
  slackBotToken: string | undefined,
  threadTs: string | undefined,
  sendSlackMessage: (
    channel: string,
    text: string,
    slackBotToken?: string,
    threadTs?: string,
    blocks?: any[]
  ) => Promise<any>
) {
  // Log as warning (not error) since this is an expected scenario for unlinked accounts
  Logger.warn(`⚠️ Slack account not linked - Slack ID: ${slackUserId}`, {
    eventId,
    messageTs,
    channel,
    context: 'User has not configured their Slack integration in profile settings',
  });

  // Send helpful message to Slack user about linking their account
  if (slackBotToken) {
    const helpMessage = [
      "👋 Hi! It looks like your Slack account isn't linked yet.",
      '',
      '📝 To get started:',
      '1. Go to your profile settings in the B4M Web App',
      '2. Navigate to the Slack Integration section',
      '3. Click "Connect with Slack" to link your Slack account and start using the B4M Slack Integration',
      "4. If you're having trouble, you may enter your Slack Member ID manually: Find your Slack Member ID: Click your profile → More → Copy member ID",
      "5. Enter your Member ID and hit the 'Save Member ID' button",
      '',
      "✅ Once linked, you can chat with me and I'll save our conversations to your notebooks!",
    ].join('\n');

    await sendSlackMessage(
      channel,
      helpMessage,
      slackBotToken,
      threadTs // Reply in thread if applicable
    );
  }
}

/**
 * Create a mock user for testing purposes (when SLACK_BYPASS_USER_LOOKUP is enabled)
 * @param slackUserId - Slack user ID
 * @param eventId - Slack event ID
 * @param messageTs - Message timestamp
 * @param channel - Slack channel ID
 * @returns Mock user object
 */
export function createMockUser(slackUserId: string, eventId: string, messageTs: string, channel: string) {
  Logger.warn('🔧 BYPASSING user lookup for testing - using mock user', {
    slackUserId,
    eventId,
    messageTs,
    channel,
  });

  return {
    id: 'mock-user-id',
    name: 'Mock User',
    slackSettings: {
      slackUserId,
      autoCreateNotebook: true,
      notebookNamePrefix: 'Slack Chat',
    },
  };
}
