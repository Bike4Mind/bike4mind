import { Logger } from '@bike4mind/observability';
import { ISlackDevWorkspaceDocument } from '@bike4mind/common';
import { getSlackDeps, getSlackDb } from './di/registry';
import type { BaseStatePayload } from './di/types';

const logger = new Logger();

// Unique audience for user-link OAuth flow (prevents cross-flow attacks)
const USER_LINK_AUDIENCE = 'slack-user-link' as const;

/**
 * Shared utilities for Slack OAuth user linking flow
 *
 * These helpers are used by:
 * - /api/slack/oauth/user-link (index.ts) - Browser redirect initiation
 * - /api/slack/oauth/user-link/initiate - API-based initiation
 * - /api/slack/oauth/user-link/callback - OAuth callback handler
 */

export interface UserLinkStatePayload extends BaseStatePayload {
  userId: string;
}

export interface GetWorkspaceResult {
  success: true;
  workspace: ISlackDevWorkspaceDocument;
}

export interface GetWorkspaceError {
  success: false;
  error: 'no_oauth_configured' | 'workspace_not_found';
  message: string;
}

/**
 * Find the first workspace with OAuth credentials configured
 * Used to get client_id and client_secret for the OAuth flow
 *
 * Uses findAllActiveWithCredentials because slackClientId has select: false
 */
export async function getOAuthWorkspaceWithCredentials(): Promise<GetWorkspaceResult | GetWorkspaceError> {
  const { slackDevWorkspaceRepository } = getSlackDb() as any;
  const allWorkspaces = await slackDevWorkspaceRepository.findAllActiveWithCredentials();
  const workspaceForCreds = allWorkspaces.find((ws: any) => ws.slackClientId);

  if (!workspaceForCreds) {
    logger.error('🔐 No workspace with OAuth credentials found');
    return {
      success: false,
      error: 'no_oauth_configured',
      message: 'No OAuth configured. Please contact your administrator.',
    };
  }

  const workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(workspaceForCreds.id);
  if (!workspace || !workspace.slackClientId) {
    logger.error('🔐 Failed to load workspace credentials', { workspaceId: workspaceForCreds.id });
    return {
      success: false,
      error: 'workspace_not_found',
      message: 'Failed to load workspace configuration',
    };
  }

  return { success: true, workspace };
}

/**
 * Build the redirect URI for the OAuth callback
 * Uses workspace's configured redirect URI or derives from request headers
 */
export function buildUserLinkRedirectUri(
  workspace: ISlackDevWorkspaceDocument,
  req: { headers: { 'x-forwarded-proto'?: string; host?: string } }
): string {
  let baseUrl: string;
  if (workspace.slackOAuthRedirectUri) {
    const workspaceRedirectUrl = new URL(workspace.slackOAuthRedirectUri);
    baseUrl = `${workspaceRedirectUrl.protocol}//${workspaceRedirectUrl.host}`;
  } else {
    baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  }
  return `${baseUrl}/api/slack/oauth/user-link/callback`;
}

/**
 * Generate a JWT state token for CSRF protection
 * Uses shared jwtStateStore utilities with algorithm pinning and OIDC claims
 * Token expires in 10 minutes
 */
export function generateUserLinkStateToken(userId: string): string {
  const { jwtStateStore } = getSlackDeps();
  return jwtStateStore.createStateToken<{ userId: string }>(
    { audience: USER_LINK_AUDIENCE, expiresIn: '10m' },
    { userId }
  );
}

export interface VerifyStateResult {
  valid: true;
  payload: UserLinkStatePayload;
}

export interface VerifyStateError {
  valid: false;
  error: 'invalid_state' | 'server_error';
  message: string;
}

/**
 * Verify and decode a JWT state token
 * Uses shared jwtStateStore utilities with audience validation
 */
export function verifyUserLinkStateToken(state: string): VerifyStateResult | VerifyStateError {
  const { jwtStateStore } = getSlackDeps();
  const result = jwtStateStore.verifyStateToken<UserLinkStatePayload>(state, { audience: USER_LINK_AUDIENCE });

  if (result.valid) {
    return { valid: true, payload: result.payload };
  }

  // Map jwtStateStore errors to user-link error format
  logger.warn('🔐 Invalid or expired state token', { reason: result.reason });
  return {
    valid: false,
    error: 'invalid_state',
    message: result.message,
  };
}

/**
 * OAuth scopes requested from users
 *
 * identity.basic CANNOT be combined with other user scopes (different OAuth flows).
 * We get the Slack user ID from authed_user.id in the OAuth response instead.
 *
 * - reminders:write: Create reminders on behalf of user
 *
 * Slack deprecated reminders.list, reminders.info, reminders.delete, and
 * reminders.complete APIs in March 2023. Only reminders.add still works.
 * See: https://api.slack.com/changelog/2023-07-its-later-already-for-the-reminders-apis
 */
export const SLACK_USER_SCOPES = ['reminders:write'] as const;

/**
 * Build the Slack OAuth authorization URL
 */
export function buildSlackOAuthUrl(clientId: string, redirectUri: string, state: string, teamId?: string): string {
  const slackAuthUrl = new URL('https://slack.com/oauth/v2/authorize');
  slackAuthUrl.searchParams.set('client_id', clientId);
  slackAuthUrl.searchParams.set('user_scope', SLACK_USER_SCOPES.join(','));
  slackAuthUrl.searchParams.set('redirect_uri', redirectUri);
  slackAuthUrl.searchParams.set('state', state);
  // Pre-select workspace so user skips the workspace picker
  if (teamId) {
    slackAuthUrl.searchParams.set('team', teamId);
  }
  return slackAuthUrl.toString();
}
