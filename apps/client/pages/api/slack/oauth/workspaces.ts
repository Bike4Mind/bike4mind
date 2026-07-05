import { slackDevWorkspaceRepository } from '@bike4mind/database/infra';
import { baseApi } from '@server/middlewares/baseApi';
import { Logger } from '@bike4mind/observability';

const logger = new Logger();

/**
 * User-facing API for getting available Slack workspaces for OAuth linking
 *
 * GET /api/slack/oauth/workspaces
 * Returns: List of active workspaces with OAuth configured (limited fields for security)
 *
 * This endpoint is for authenticated users to see which workspaces they can link their account to.
 * It does NOT expose OAuth credentials - only workspace name and ID.
 */

const handler = baseApi().get(async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Get all active workspaces with credentials included (needed to check slackClientId)
  // Note: slackClientId has select: false in schema, so we must use findAllActiveWithCredentials
  const allWorkspaces = await slackDevWorkspaceRepository.findAllActiveWithCredentials();

  // Filter to only workspaces with OAuth client ID configured
  // and only return safe fields (not credentials)
  const workspaces = allWorkspaces
    .filter(ws => ws.slackClientId) // Must have OAuth configured
    .map(ws => ({
      id: ws.id,
      name: ws.name,
      slackTeamId: ws.slackTeamId,
    }));

  logger.debug('🔗 Fetched OAuth-enabled workspaces for user linking', {
    userId: req.user.id,
    count: workspaces.length,
  });

  return res.json({ workspaces });
});

export default handler;
