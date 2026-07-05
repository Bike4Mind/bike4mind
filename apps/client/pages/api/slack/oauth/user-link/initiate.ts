import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import {
  getOAuthWorkspaceWithCredentials,
  buildUserLinkRedirectUri,
  generateUserLinkStateToken,
  buildSlackOAuthUrl,
} from '@bike4mind/slack';

const logger = new Logger();

/**
 * Slack OAuth User Linking - Get Initiation URL
 *
 * Returns the Slack OAuth URL for the client to redirect to.
 * This endpoint requires authentication (JWT via Authorization header).
 *
 * GET /api/slack/oauth/user-link/initiate
 * Returns: { redirectUrl: string }
 *
 * This is used instead of direct browser navigation to /api/slack/oauth/user-link
 * because browser navigation doesn't include the Authorization header.
 */

const handler = baseApi().get(async (req, res) => {
  // baseApi with auth:true ensures req.user exists
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const workspaceResult = await getOAuthWorkspaceWithCredentials();
    if (!workspaceResult.success) {
      const statusCode = workspaceResult.error === 'no_oauth_configured' ? 400 : 500;
      return res.status(statusCode).json({ error: workspaceResult.message });
    }
    const workspace = workspaceResult.workspace;

    // Generate state token and build OAuth URL
    const state = generateUserLinkStateToken(req.user.id);
    const redirectUri = buildUserLinkRedirectUri(workspace, req);
    const slackAuthUrl = buildSlackOAuthUrl(workspace.slackClientId!, redirectUri, state, workspace.slackTeamId);

    logger.info('🔗 Generated Slack user linking OAuth URL', {
      userId: req.user.id,
      credentialsFromWorkspace: workspace.name,
      redirectUri,
    });

    return res.json({ redirectUrl: slackAuthUrl });
  } catch (error: any) {
    logger.error('❌ Slack user linking initiation error', {
      error: error.message,
      userId: req.user?.id,
    });
    return res.status(500).json({ error: 'Failed to initiate Slack connection' });
  }
});

export default handler;
