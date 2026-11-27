import { Logger } from '@bike4mind/observability';
import type { ISlackDevWorkspaceDocument } from '@bike4mind/common';
import { getSlackDeps, getSlackDb } from './di/registry';
import type { BaseStatePayload } from './di/types';
import { getControlledScopes } from './manifestTemplate';
import { selectSlackAppRow } from './slackAppSelection';

const logger = new Logger();

const ORG_SLACK_CONNECT_AUDIENCE = 'org-slack-connect' as const;

export interface OrgSlackConnectStatePayload extends BaseStatePayload {
  organizationId: string;
  userId: string;
  /** Slack app row the flow was started with; absent on states minted before the app was carried. */
  workspaceId?: string;
}

export interface SystemSlackAppCredentials {
  workspaceId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string | undefined;
  appId: string;
}

/**
 * Get a Slack app's credentials for the org OAuth flow: the active SlackDevWorkspace row named by
 * `workspaceId`, or the first active row with OAuth credentials when none is named.
 */
export async function getSystemSlackAppCredentials(workspaceId?: string): Promise<SystemSlackAppCredentials | null> {
  // DI types repositories as unknown; the bound implementation is the database SlackDevWorkspace repository.
  const slackDevWorkspaceRepository = getSlackDb().slackDevWorkspaceRepository as {
    findAllActiveWithCredentials(): Promise<ISlackDevWorkspaceDocument[]>;
  };
  const workspaces = await slackDevWorkspaceRepository.findAllActiveWithCredentials();
  const workspace = selectSlackAppRow(workspaces, workspaceId);

  if (!workspace || !workspace.slackClientId || !workspace.slackClientSecret) {
    logger.error('[ORG-SLACK] No Slack app with OAuth credentials found', { requestedWorkspaceId: workspaceId });
    return null;
  }

  return {
    workspaceId: workspace.id,
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
export function generateOrgSlackConnectStateToken(
  organizationId: string,
  userId: string,
  nonceHash?: string,
  workspaceId?: string
): string {
  const { jwtStateStore } = getSlackDeps();
  return jwtStateStore.createStateToken<{ organizationId: string; userId: string; workspaceId?: string }>(
    { audience: ORG_SLACK_CONNECT_AUDIENCE, expiresIn: '10m' },
    { organizationId, userId, ...(workspaceId ? { workspaceId } : {}) },
    nonceHash
  );
}

/**
 * Verify and decode an org Slack connect state token.
 */
export function verifyOrgSlackConnectStateToken(
  state: string,
  expectedNonceHash?: string | null
): { valid: true; payload: OrgSlackConnectStatePayload } | { valid: false; error: string } {
  const { jwtStateStore } = getSlackDeps();
  const result = jwtStateStore.verifyStateToken<OrgSlackConnectStatePayload>(
    state,
    { audience: ORG_SLACK_CONNECT_AUDIENCE },
    expectedNonceHash
  );

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
