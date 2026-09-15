import { baseApi } from '@server/middlewares/baseApi';
import { questRepository, sessionRepository } from '@bike4mind/database';

/**
 * GET /api/sessions/recent-proactive-messages
 * Returns sessions with their latest proactive message timestamp for the authenticated user's top 20 recent sessions
 *
 * Response:
 * {
 *   [sessionId: string]: string  // ISO timestamp of the latest proactive message
 * }
 */
const handler = baseApi().get(async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.json({});
    }

    const recentSessions = await sessionRepository.find(
      {
        userId: userId,
        deletedAt: { $exists: false },
      },
      {
        sort: { lastUpdated: -1 },
        limit: 20,
      }
    );

    if (recentSessions.length === 0) {
      return res.json({});
    }

    // Find sessions where the latest message is a proactive message
    const sessionsWithProactiveMessages: Record<string, string> = {};

    await Promise.all(
      recentSessions.map(async session => {
        const latestMessages = await questRepository.getMostRecentChatHistory(session.id, 1);

        if (latestMessages.length > 0) {
          const latestMessage = latestMessages[0];

          if (latestMessage.prompt?.match(/^\[Proactive message from .+\]$/)) {
            sessionsWithProactiveMessages[session.id] = latestMessage.timestamp.toISOString();
          }
        }
      })
    );

    res.json(sessionsWithProactiveMessages);
  } catch (error) {
    req.logger.error('Error getting recent proactive messages:', error as Error);
    res.json({});
  }
});

export default handler;
