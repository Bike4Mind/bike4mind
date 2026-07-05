import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { Logger } from '@bike4mind/observability';
import { slackDevWorkspaceRepository } from '@bike4mind/database/infra';
import { orgSlackWorkspaceRepository } from '@bike4mind/database/infra';
import { User, userRepository } from '@bike4mind/database/auth';
import { baseApi } from '@server/middlewares/baseApi';
import { getOAuthWorkspaceWithCredentials, buildUserLinkRedirectUri, verifyUserLinkStateToken } from '@bike4mind/slack';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { encryptToken } from '@server/security/tokenEncryption';
import { randomUUID } from 'crypto';

const logger = new Logger();

/**
 * Slack OAuth User Linking - Callback Handler
 *
 * Handles the OAuth callback from Slack after user grants permission.
 * Extracts the user's Slack ID and links it to their B4M account.
 *
 * GET /api/slack/oauth/user-link/callback?code=xxx&state=yyy
 * Redirects to: /profile?tab=integrations&slack_linked=true or /profile?tab=integrations&slack_error=xxx
 *
 * Flow:
 * 1. Verify state parameter (CSRF protection)
 * 2. Get OAuth credentials from first configured workspace
 * 3. Exchange code for user access token
 * 4. Verify the user's Slack team is configured in our system
 * 5. Extract Slack user ID from response
 * 6. Check for duplicate linking
 * 7. Update user's slackSettings.slackUserId
 * 8. Redirect to settings with result
 */

const handler = baseApi({ auth: false }).get(async (req, res) => {
  const { code, state, error } = req.query;

  const auditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'oauth',
      integrationName: 'slack',
      action: 'user_link_callback',
      requestId: randomUUID(),
    },
    req
  );

  logger.info('🔐 [OAuth Callback] Received callback', {
    hasCode: !!code,
    hasState: !!state,
    hasError: !!error,
    error: error || null,
  });

  // Handle OAuth errors from Slack
  if (error) {
    logger.info('🔐 Slack user linking denied by user', { error });
    const errorCode = error === 'access_denied' ? 'access_denied' : 'oauth_error';
    auditLogger.failure(errorCode);
    return res.redirect(`/profile?tab=integrations&slack_error=${errorCode}`);
  }

  if (!code || !state) {
    logger.info('🔐 Slack user linking callback missing code or state');
    auditLogger.failure('invalid_params');
    return res.redirect('/profile?tab=integrations&slack_error=invalid_params');
  }

  const stateResult = verifyUserLinkStateToken(state as string);
  if (!stateResult.valid) {
    auditLogger.failure(stateResult.error || 'invalid_state');
    return res.redirect(`/profile?tab=integrations&slack_error=${stateResult.error}`);
  }
  const { userId } = stateResult.payload;
  auditLogger.setUserId(userId);
  const codePrefix = (code as string).substring(0, 10) + '...'; // Truncated for security

  try {
    const workspaceResult = await getOAuthWorkspaceWithCredentials();
    if (!workspaceResult.success) {
      auditLogger.failure(workspaceResult.error || 'workspace_error');
      return res.redirect(`/profile?tab=integrations&slack_error=${workspaceResult.error}`);
    }
    const workspace = workspaceResult.workspace;

    if (!workspace.slackClientSecret) {
      logger.error('🔐 Workspace missing client secret');
      auditLogger.failure('missing_client_secret');
      return res.redirect('/profile?tab=integrations&slack_error=workspace_not_found');
    }

    // Build redirect URI (must match what was sent in authorization request)
    const redirectUri = buildUserLinkRedirectUri(workspace, req);

    // Exchange code for access token
    const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: workspace.slackClientId!,
        client_secret: workspace.slackClientSecret,
        code: code as string,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text().catch(() => '');
      logger.error('🔐 Slack API HTTP error during user link', {
        status: tokenResponse.status,
        bodyPreview: body.substring(0, 200),
        userId,
      });
      auditLogger.failure('slack_unavailable');
      return res.redirect('/profile?tab=integrations&slack_error=slack_unavailable');
    }

    const tokenData = await tokenResponse.json();

    logger.info('🔐 [OAuth Callback] Token exchange response', {
      ok: tokenData.ok,
      error: tokenData.error || null,
      hasAuthedUser: !!tokenData.authed_user,
      hasAccessToken: !!tokenData.authed_user?.access_token,
      scopes: tokenData.authed_user?.scope || 'none',
      teamId: tokenData.team?.id,
      teamName: tokenData.team?.name,
    });

    if (!tokenData.ok) {
      logger.error('🔐 Slack token exchange failed', {
        error: tokenData.error,
        userId,
      });
      auditLogger.failure(tokenData.error || 'token_exchange_failed');
      return res.redirect(`/profile?tab=integrations&slack_error=${tokenData.error || 'token_exchange_failed'}`);
    }

    // Extract user's Slack ID and team from the response
    const slackUserId = tokenData.authed_user?.id;
    const slackTeamId = tokenData.team?.id;

    if (!slackUserId) {
      logger.error('🔐 No Slack user ID in token response', { tokenData: JSON.stringify(tokenData) });
      auditLogger.failure('no_user_id');
      return res.redirect('/profile?tab=integrations&slack_error=no_user_id');
    }

    // Verify the user's Slack team is configured in our system
    if (slackTeamId) {
      const userWorkspace = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(slackTeamId);
      if (userWorkspace) {
        logger.info('✅ User Slack workspace verified (system)', {
          slackTeamId,
          workspaceName: userWorkspace.name,
        });
      } else {
        // Fallback: check org-level Slack workspaces
        const orgWorkspace = await orgSlackWorkspaceRepository.findBySlackTeamId(slackTeamId);
        if (!orgWorkspace) {
          logger.info('🔐 User authenticated with unconfigured Slack workspace', {
            slackTeamId,
            slackTeamName: tokenData.team?.name,
            userId,
          });
          auditLogger.failure('workspace_not_connected');
          return res.redirect('/profile?tab=integrations&slack_error=workspace_not_connected');
        }
        logger.info('✅ User Slack workspace verified (org)', {
          slackTeamId,
          organizationId: orgWorkspace.organizationId,
        });
      }
    }

    // Check if this Slack ID is already linked to another user
    const existingUser = await userRepository.findBySlackUserId(slackUserId);

    if (existingUser && existingUser.id !== userId) {
      logger.info('🔐 Slack ID already linked to another user', {
        slackUserId,
        requestingUserId: userId,
        existingUserId: existingUser.id,
      });
      auditLogger.failure('already_linked');
      return res.redirect('/profile?tab=integrations&slack_error=already_linked');
    }

    // Extract user access token and scopes from response
    const userAccessToken = tokenData.authed_user?.access_token;
    const grantedScopes = tokenData.authed_user?.scope?.split(',') || [];

    // Build update payload - store token as plain string (consistent with Google Drive, Atlassian)
    // Token is protected by select: false in the schema
    const updatePayload: Record<string, unknown> = {
      'slackSettings.slackUserId': slackUserId,
      'slackSettings.slackUserScopes': grantedScopes,
    };

    if (userAccessToken) {
      updatePayload['slackSettings.slackUserToken'] = encryptToken(userAccessToken);
      logger.info('🔐 Storing user access token', {
        userId,
        scopesGranted: grantedScopes.length,
      });
    }

    // Update user's Slack settings
    await User.findByIdAndUpdate(userId, { $set: updatePayload }, { new: true });

    logger.info('✅ Slack user linking successful', {
      userId,
      slackUserId,
      slackTeamId,
      scopesGranted: grantedScopes,
    });

    if (slackTeamId) auditLogger.setWorkspaceId(slackTeamId);
    auditLogger.success({ slackUserId, slackTeamId, scopesGranted: grantedScopes });

    return res.redirect('/profile?tab=integrations&slack_linked=true');
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('❌ Slack user linking callback error', {
      error: error.message,
      stack: error.stack,
      userId,
      codePrefix, // Truncated OAuth code for tracing
    });
    auditLogger.failure('callback_error');
    return res.redirect('/profile?tab=integrations&slack_error=server_error');
  }
});

export default handler;
