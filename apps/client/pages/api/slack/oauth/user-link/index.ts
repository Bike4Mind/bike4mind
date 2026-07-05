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
 * Slack OAuth User Linking - Initiate Flow (Browser Redirect)
 *
 * This endpoint initiates the OAuth flow for linking a user's B4M account
 * to their Slack identity and granting reminders permissions.
 *
 * GET /api/slack/oauth/user-link
 * Redirects to: Slack OAuth consent page
 *
 * Flow:
 * 1. Auto-pick first available workspace with OAuth configured (for credentials only)
 * 2. Redirect to Slack OAuth WITHOUT team parameter (Slack handles workspace selection)
 * 3. User picks their Slack workspace on Slack's UI
 * 4. Callback verifies the selected team is configured in our system
 *
 * Requirements:
 * - User must be authenticated
 * - At least one workspace must have OAuth credentials configured
 * - Slack app must have `reminders:write` and `reminders:read` in User Token Scopes
 */

// Note: auth: false so we can redirect to login with proper params instead of 401
const handler = baseApi({ auth: false }).get(async (req, res) => {
  // Require authenticated user
  if (!req.user) {
    logger.warn('🔐 User linking attempted without authentication');
    return res.redirect(`/login?redirect=${encodeURIComponent('/profile?tab=integrations&slack_error=auth_required')}`);
  }

  try {
    const workspaceResult = await getOAuthWorkspaceWithCredentials();
    if (!workspaceResult.success) {
      return res.redirect(`/profile?tab=integrations&slack_error=${workspaceResult.error}`);
    }
    const workspace = workspaceResult.workspace;

    // Generate state token and build OAuth URL
    const state = generateUserLinkStateToken(req.user.id);
    const redirectUri = buildUserLinkRedirectUri(workspace, req);
    const slackAuthUrl = buildSlackOAuthUrl(workspace.slackClientId!, redirectUri, state, workspace.slackTeamId);

    logger.info('🔗 Initiating Slack user linking OAuth', {
      userId: req.user.id,
      credentialsFromWorkspace: workspace.name,
      redirectUri,
    });

    return res.redirect(slackAuthUrl);
  } catch (error: any) {
    logger.error('❌ Slack user linking initialization error', {
      error: error.message,
      userId: req.user?.id,
    });
    return res.redirect('/profile?tab=integrations&slack_error=init_failed');
  }
});

export default handler;
