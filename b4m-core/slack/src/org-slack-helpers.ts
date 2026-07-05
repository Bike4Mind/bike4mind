import { Logger } from '@bike4mind/observability';
import { getSlackDeps, getSlackDb } from './di/registry';
import type { BaseStatePayload } from './di/types';
import { getControlledScopes } from './manifestTemplate';

const logger = new Logger();

const ORG_SLACK_CONNECT_AUDIENCE = 'org-slack-connect' as const;

export interface OrgSlackConnectStatePayload extends BaseStatePayload {
  organizationId: string;
  userId: string;
}

/**
 * Get the system's Slack app credentials for org OAuth flow.
 * Reuses the first active SlackDevWorkspace with OAuth credentials.
 */
export async function getSystemSlackAppCredentials() {
  const { slackDevWorkspaceRepository } = getSlackDb() as any;
  const workspaces = await slackDevWorkspaceRepository.findAllActiveWithCredentials();
  const workspace = workspaces.find((ws: any) => ws.slackClientId && ws.slackClientSecret);

  if (!workspace || !workspace.slackClientId || !workspace.slackClientSecret) {
    logger.error('[ORG-SLACK] No system Slack app with OAuth credentials found');
    return null;
  }

  return {
    clientId: workspace.slackClientId,
    clientSecret: workspace.slackClientSecret,
    signingSecret: workspace.slackOAuthSigningSecret,
    appId: workspace.slackAppId,
  };
}

/**
 * Generate a JWT state token for org Slack connect OAuth flow.
 * Token expires in 10 minutes.
 */
export function generateOrgSlackConnectStateToken(organizationId: string, userId: string): string {
  const { jwtStateStore } = getSlackDeps();
  return jwtStateStore.createStateToken<{ organizationId: string; userId: string }>(
    { audience: ORG_SLACK_CONNECT_AUDIENCE, expiresIn: '10m' },
    { organizationId, userId }
  );
}

/**
 * Verify and decode an org Slack connect state token.
 */
export function verifyOrgSlackConnectStateToken(
  state: string
): { valid: true; payload: OrgSlackConnectStatePayload } | { valid: false; error: string } {
  const { jwtStateStore } = getSlackDeps();
  const result = jwtStateStore.verifyStateToken<OrgSlackConnectStatePayload>(state, {
    audience: ORG_SLACK_CONNECT_AUDIENCE,
  });

  if (result.valid) {
    return { valid: true, payload: result.payload };
  }

  logger.warn('[ORG-SLACK] Invalid or expired state token', { reason: result.reason });
  return { valid: false, error: result.message };
}

/**
 * Build the Slack OAuth authorization URL for org workspace installation.
 * Uses bot scopes (same as admin install) for full feature parity.
 */
export function buildOrgSlackOAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const botScopes = getControlledScopes().bot;

  const slackAuthUrl = new URL('https://slack.com/oauth/v2/authorize');
  slackAuthUrl.searchParams.set('client_id', clientId);
  slackAuthUrl.searchParams.set('scope', botScopes.join(','));
  slackAuthUrl.searchParams.set('redirect_uri', redirectUri);
  slackAuthUrl.searchParams.set('state', state);
  return slackAuthUrl.toString();
}
