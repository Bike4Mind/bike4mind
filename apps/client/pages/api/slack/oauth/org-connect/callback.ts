import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

/**
 * Organization Slack Workspace - OAuth Callback
 *
 * GET /api/slack/oauth/org-connect/callback?code=xxx&state=yyy
 *
 * Handles the OAuth callback from Slack after org owner authorizes.
 * Exchanges code for tokens and creates OrgSlackWorkspace record.
 * Uses sessionStorage + client-side routing to redirect back to org settings
 * (direct redirects fail on CloudFront preview deployments).
 */

import { Logger } from '@bike4mind/observability';
import { orgSlackWorkspaceRepository } from '@bike4mind/database/infra';
import { organizationRepository } from '@bike4mind/database/infra';
import { baseApi } from '@server/middlewares/baseApi';
import { getSystemSlackAppCredentials, verifyOrgSlackConnectStateToken } from '@bike4mind/slack';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { encryptToken } from '@server/security/tokenEncryption';
import { randomUUID } from 'crypto';
import type { Response } from 'express';

const logger = new Logger();

/**
 * Stores the target SPA path in sessionStorage, then navigates to "/".
 * CloudFront can't serve SPA routes directly (returns Access Denied),
 * so we land on "/" which loads the SPA, then the app reads sessionStorage
 * and navigates internally via client-side routing.
 */
function sendClientRedirect(res: Response, path: string) {
  // JSON.stringify properly escapes all JS-special chars; replace < prevents </script> breakout
  const safeJsonString = JSON.stringify(path).replace(/</g, '\\u003c');
  res.setHeader('Content-Type', 'text/html');
  return res
    .status(200)
    .send(
      `<!DOCTYPE html><html><head><script>sessionStorage.setItem("__slack_redirect",${safeJsonString});window.location.replace("/");</script></head><body>Redirecting...</body></html>`
    );
}

const handler = baseApi({ auth: false }).get(async (req, res) => {
  const { code, state, error } = req.query;

  const auditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'oauth',
      integrationName: 'slack',
      action: 'org_connect_callback',
      requestId: randomUUID(),
    },
    req
  );

  logger.info('[ORG-SLACK-CALLBACK] Received callback', {
    hasCode: !!code,
    hasState: !!state,
    hasError: !!error,
  });

  // Handle OAuth errors from Slack (state is still available on denial)
  if (error) {
    logger.info('[ORG-SLACK-CALLBACK] OAuth error from Slack', { error });
    auditLogger.failure((error as string) || 'access_denied');
    const stateForError = state ? verifyOrgSlackConnectStateToken(state as string) : null;
    if (stateForError?.valid) {
      return sendClientRedirect(
        res,
        `/organizations/${stateForError.payload.organizationId}?tab=integrations&slack_error=access_denied`
      );
    }
    return sendClientRedirect(res, '/organizations?slack_error=access_denied');
  }

  if (!code || !state) {
    auditLogger.failure('invalid_params');
    return sendClientRedirect(res, '/organizations?slack_error=invalid_params');
  }

  const stateResult = verifyOrgSlackConnectStateToken(state as string);
  if (!stateResult.valid) {
    auditLogger.failure('invalid_state');
    return sendClientRedirect(res, '/organizations?slack_error=invalid_state');
  }

  const { organizationId, userId } = stateResult.payload;
  auditLogger.setUserId(userId);
  const orgRedirectBase = `/organizations/${organizationId}`;

  try {
    // Verify the org still exists
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      auditLogger.failure('org_not_found');
      return sendClientRedirect(res, '/organizations?slack_error=org_not_found');
    }

    // Get system app credentials for token exchange
    const appCredentials = await getSystemSlackAppCredentials();
    if (!appCredentials) {
      auditLogger.failure('no_app_configured');
      return sendClientRedirect(res, `${orgRedirectBase}?tab=integrations&slack_error=no_app_configured`);
    }

    // Build redirect URI (must match what was sent in authorization request)
    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const redirectUri = `${baseUrl}/api/slack/oauth/org-connect/callback`;

    // Exchange code for access token
    const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appCredentials.clientId,
        client_secret: appCredentials.clientSecret,
        code: code as string,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text().catch(() => '');
      logger.error('[ORG-SLACK-CALLBACK] Slack API HTTP error', {
        status: tokenResponse.status,
        bodyPreview: body.substring(0, 200),
        organizationId,
      });
      auditLogger.failure('slack_unavailable');
      return sendClientRedirect(res, `${orgRedirectBase}?tab=integrations&slack_error=slack_unavailable`);
    }

    const tokenData = await tokenResponse.json();

    logger.info('[ORG-SLACK-CALLBACK] Token exchange response', {
      ok: tokenData.ok,
      error: tokenData.error || null,
      teamId: tokenData.team?.id,
      teamName: tokenData.team?.name,
      hasBotToken: !!tokenData.access_token,
    });

    if (!tokenData.ok) {
      logger.error('[ORG-SLACK-CALLBACK] Token exchange failed', { error: tokenData.error });
      auditLogger.failure(tokenData.error || 'token_exchange_failed');
      const safeError = encodeURIComponent(tokenData.error || 'token_exchange_failed');
      return sendClientRedirect(res, `${orgRedirectBase}?tab=integrations&slack_error=${safeError}`);
    }

    const slackTeamId = tokenData.team?.id;
    const slackTeamName = tokenData.team?.name;
    const botToken = tokenData.access_token;
    const botUserId = tokenData.bot_user_id;
    const appId = tokenData.app_id;

    if (!slackTeamId || !botToken) {
      logger.error('[ORG-SLACK-CALLBACK] Missing team ID or bot token in response');
      auditLogger.failure('incomplete_response');
      return sendClientRedirect(res, `${orgRedirectBase}?tab=integrations&slack_error=incomplete_response`);
    }

    // Check if this workspace is already connected to another org (including disabled)
    const existingOrgWorkspace = await orgSlackWorkspaceRepository.findBySlackTeamIdAny(slackTeamId);
    if (existingOrgWorkspace && existingOrgWorkspace.organizationId !== organizationId) {
      logger.info('[ORG-SLACK-CALLBACK] Workspace already connected to another org', {
        slackTeamId,
        existingOrgId: existingOrgWorkspace.organizationId,
        requestedOrgId: organizationId,
      });
      auditLogger.failure('workspace_taken');
      return sendClientRedirect(res, `${orgRedirectBase}?tab=integrations&slack_error=workspace_taken`);
    }

    // Check if org already has a workspace connected
    const existingForOrg = await orgSlackWorkspaceRepository.findByOrganizationId(organizationId);
    if (existingForOrg) {
      // Update existing record (reconnect scenario)
      await orgSlackWorkspaceRepository.update({
        id: existingForOrg.id,
        slackTeamId,
        slackTeamName,
        slackAppId: appId || appCredentials.appId,
        slackBotToken: encryptToken(botToken)!,
        slackBotUserId: botUserId,
        enabled: true,
        installedAt: new Date(),
        installedBy: userId,
      });
      logger.info('[ORG-SLACK-CALLBACK] Reconnected workspace', { organizationId, slackTeamId });
    } else {
      await orgSlackWorkspaceRepository.create({
        organizationId,
        slackTeamId,
        slackTeamName,
        slackAppId: appId || appCredentials.appId,
        slackBotToken: encryptToken(botToken)!,
        slackBotUserId: botUserId,
        slackBotId: botUserId,
        enabled: true,
        installedAt: new Date(),
        installedBy: userId,
      });
      logger.info('[ORG-SLACK-CALLBACK] Connected new workspace', { organizationId, slackTeamId, slackTeamName });
    }

    auditLogger.setWorkspaceId(slackTeamId);
    auditLogger.success({ slackTeamId, slackTeamName, organizationId });

    return sendClientRedirect(res, `${orgRedirectBase}?tab=integrations&slack_connected=true`);
  } catch (err: unknown) {
    // Handle MongoDB duplicate key (race condition: concurrent OAuth for same team)
    if (err instanceof Error && 'code' in err && (err as Error & { code: number }).code === 11000) {
      logger.warn('[ORG-SLACK-CALLBACK] Duplicate key race condition', { organizationId });
      auditLogger.failure('duplicate_key_race');
      return sendClientRedirect(res, `${orgRedirectBase}?tab=integrations&slack_error=workspace_taken`);
    }

    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('[ORG-SLACK-CALLBACK] Error', {
      errorName: error.name,
      error: error.message,
      stack: error.stack,
      organizationId,
      userId,
    });
    auditLogger.failure('callback_error');
    return sendClientRedirect(res, `${orgRedirectBase}?tab=integrations&slack_error=server_error`);
  }
});

export default handler;
