import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { baseApi } from '@server/middlewares/baseApi';
import { userRepository, mcpServerRepository, User } from '@bike4mind/database';
import { McpServerName, ROTATABLE_INTEGRATIONS, type RotatableIntegration } from '@bike4mind/common';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { randomUUID } from 'crypto';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { getAtlassianOAuthConfig, ATLASSIAN_OAUTH_SCOPES } from '@server/integrations/jira/atlassianConfig';
import { getNotionOAuthConfig, NOTION_OAUTH_AUTHORIZE_URL } from '@server/integrations/notion';
import {
  getOAuthWorkspaceWithCredentials,
  buildUserLinkRedirectUri,
  generateUserLinkStateToken,
  buildSlackOAuthUrl,
} from '@bike4mind/slack';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Config } from '@server/utils/config';
import { recordTokenRotationInitiated, recordTokenRotationFailed } from '@server/utils/cloudwatch';

function isRotatableIntegration(value: string): value is RotatableIntegration {
  return (ROTATABLE_INTEGRATIONS as readonly string[]).includes(value);
}

const handler = baseApi().post(async (req, res) => {
  const integration = req.query.integration as string;
  const userId = req.user.id;

  if (!isRotatableIntegration(integration)) {
    return res.status(400).json({ error: 'Invalid integration. Must be one of: github, atlassian, slack, notion' });
  }

  const VALID_REASONS = ['manual_rotation', 'security_incident', 'scheduled_rotation', 'token_expired'] as const;
  const rawReason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual_rotation';
  const reason = (VALID_REASONS as readonly string[]).includes(rawReason) ? rawReason : 'manual_rotation';

  const requestId = randomUUID().split('-')[0];
  const auditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'token_refresh',
      integrationName: integration,
      action: 'token_rotation_initiated',
      requestId,
      userId,
      metadata: { reason },
    },
    req
  );

  try {
    // Verify user exists and integration is connected
    const user = await userRepository.findById(userId);
    if (!user) {
      auditLogger.failure('user_not_found');
      return res.status(404).json({ error: 'User not found' });
    }

    if (integration === 'github') {
      const mcpServer = await mcpServerRepository.findOne({ userId, name: McpServerName.Github });
      if (!mcpServer?.enabled) {
        auditLogger.failure('integration_not_connected');
        return res.status(400).json({ error: 'GitHub integration is not connected' });
      }
    } else if (integration === 'atlassian') {
      if (!user.atlassianConnect) {
        auditLogger.failure('integration_not_connected');
        return res.status(400).json({ error: 'Atlassian integration is not connected' });
      }
    } else if (integration === 'slack') {
      if (!user.slackSettings?.slackUserId) {
        auditLogger.failure('integration_not_connected');
        return res.status(400).json({ error: 'Slack integration is not connected' });
      }
    } else if (integration === 'notion') {
      if (!user.notionConnect) {
        auditLogger.failure('integration_not_connected');
        return res.status(400).json({ error: 'Notion integration is not connected' });
      }
    }

    // Generate the provider OAuth URL first - only stamp rotation if URL generation succeeds
    const authUrl = await generateAuthUrl(integration, userId, req);

    // Stamp rotation record on the user - best-effort, don't block the auth URL response.
    // Use dot-notation $set for atomicity so concurrent rotations of different
    // integrations don't overwrite each other (last-write-wins).
    // Existing documents may have integrationRotation: null, which causes
    // "Cannot create field 'X' in element {integrationRotation: null}",
    // so we initialize the parent to {} only when null, then set the nested field.
    try {
      // Only initialize if null - filter ensures we don't overwrite existing data
      await User.updateOne({ _id: userId, integrationRotation: null }, { $set: { integrationRotation: {} } });
      await User.findByIdAndUpdate(userId, {
        $set: {
          [`integrationRotation.${integration}`]: {
            lastRotationInitiatedAt: new Date(),
            lastRotationReason: reason,
          },
        },
      });
    } catch (dbError) {
      req.logger.warn('Failed to stamp rotation record, proceeding with auth URL', {
        integration,
        userId,
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
    }

    auditLogger.success({ reason });
    void recordTokenRotationInitiated(integration, reason);
    return res.status(200).json({ authUrl });
  } catch (error) {
    req.logger.error('Token rotation failed', { error, integration, userId });
    auditLogger.failure('rotation_failed');
    const errorType =
      error instanceof Error && error.message.includes('not configured')
        ? 'misconfiguration'
        : error instanceof Error && error.message.includes('JWT_SECRET')
          ? 'configuration_error'
          : 'unexpected_error';
    void recordTokenRotationFailed(integration, errorType);
    return res.status(500).json({ error: 'Failed to initiate token rotation' });
  }
});

async function generateAuthUrl(
  integration: RotatableIntegration,
  userId: string,
  req: { headers: Record<string, string | string[] | undefined> }
): Promise<string> {
  // Prefer APP_URL for consistent redirect_uri matching with registered OAuth apps
  let baseUrl = process.env.APP_URL?.replace(/\/$/, '');
  if (!baseUrl) {
    const rawProto = req.headers['x-forwarded-proto'];
    const protocol = (Array.isArray(rawProto) ? rawProto[0] : (rawProto ?? 'https')).split(',')[0].trim();
    const rawHost = req.headers['x-forwarded-host'] ?? req.headers.host;
    const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
    if (!host) throw new Error('Could not determine host from request headers');
    baseUrl = `${protocol}://${host}`;
  }

  const secret = Config.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is required');

  switch (integration) {
    case 'github': {
      const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
      const clientId = getSettingsValue('githubMcpClientId', settings);
      if (!clientId) throw new Error('GitHub OAuth not configured');

      const state = jwt.sign({ userId }, secret, { expiresIn: '10m' });
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `${baseUrl}/api/auth/github/mcp-callback`,
        scope: 'repo,read:org,read:user,project',
        state,
        allow_signup: 'false',
      });
      return `https://github.com/login/oauth/authorize?${params.toString()}`;
    }

    case 'atlassian': {
      const { clientId, redirectUri } = await getAtlassianOAuthConfig();
      if (!clientId || !redirectUri) throw new Error('Atlassian OAuth not configured');

      const csrfToken = crypto.randomBytes(32).toString('hex');
      const timestamp = Date.now();

      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(`${userId}:${csrfToken}:${timestamp}`);
      const signature = hmac.digest('hex');

      const state = encodeURIComponent(
        JSON.stringify({
          userId,
          referrer: '/profile?tab=integrations',
          csrfToken,
          timestamp,
          signature,
        })
      );

      const authUrl = new URL('https://auth.atlassian.com/authorize');
      authUrl.searchParams.set('audience', 'api.atlassian.com');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('scope', ATLASSIAN_OAUTH_SCOPES);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('prompt', 'consent');
      return authUrl.toString();
    }

    case 'slack': {
      const workspaceResult = await getOAuthWorkspaceWithCredentials();
      if (!workspaceResult.success) throw new Error(workspaceResult.message);

      const workspace = workspaceResult.workspace;
      if (!workspace.slackClientId) throw new Error('Slack OAuth not configured: missing client ID');
      const state = generateUserLinkStateToken(userId);
      const redirectUri = buildUserLinkRedirectUri(workspace, req as Parameters<typeof buildUserLinkRedirectUri>[1]);
      return buildSlackOAuthUrl(workspace.slackClientId, redirectUri, state, workspace.slackTeamId);
    }

    case 'notion': {
      const { clientId, redirectUri } = await getNotionOAuthConfig();
      if (!clientId || !redirectUri) throw new Error('Notion OAuth not configured');

      const csrfToken = crypto.randomBytes(32).toString('hex');
      const timestamp = Date.now();

      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(`${userId}:${csrfToken}:${timestamp}`);
      const signature = hmac.digest('hex');

      const state = encodeURIComponent(
        JSON.stringify({
          userId,
          referrer: '/profile?tab=integrations',
          csrfToken,
          timestamp,
          signature,
        })
      );

      const authUrl = new URL(NOTION_OAUTH_AUTHORIZE_URL);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('owner', 'user');
      authUrl.searchParams.set('state', state);
      return authUrl.toString();
    }

    default: {
      const _exhaustive: never = integration;
      throw new Error(`Unsupported integration: ${_exhaustive}`);
    }
  }
}

export default handler;
