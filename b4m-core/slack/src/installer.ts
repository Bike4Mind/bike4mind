import { InstallProvider, InstallURLOptions, StateStore } from '@slack/oauth';
import { NotFoundError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { getSlackDeps, getSlackDb } from './di/registry';
import type { BaseStatePayload } from './di/types';
import { getControlledScopes } from './manifestTemplate';
import { SlackClient } from './SlackClient';

// Slack-specific audience for state tokens
const SLACK_AUDIENCE = 'slack-oauth-state' as const;
const STATE_TOKEN_OPTIONS = { audience: SLACK_AUDIENCE };

/**
 * Slack OAuth InstallProvider
 *
 * Handles OAuth flow with built-in:
 * - CSRF protection (state parameter)
 * - Token exchange
 * - Error handling
 */

// Metadata set during installation (used by callback handler)
export interface InstallationMetadata {
  isReinstall: boolean;
  teamName: string;
  teamId: string;
}

// Scopes required for the bot - derived from the manifest template (single source of truth)
export const SLACK_BOT_SCOPES = getControlledScopes().bot;

interface SlackStatePayload extends BaseStatePayload {
  installOptions: InstallURLOptions;
}

/** Browser-binding nonce hashes: mint embeds nonceHash, verify requires expectedNonceHash (null fails closed). */
export interface StateBinding {
  nonceHash?: string;
  expectedNonceHash?: string | null;
}

// Missing binding means no cookie, never "skip the check": an unbound install state must not verify.
const verifyInstallState = (state: string, expectedNonceHash: string | null | undefined) =>
  getSlackDeps().jwtStateStore.verifyStateToken<SlackStatePayload>(
    state,
    STATE_TOKEN_OPTIONS,
    expectedNonceHash ?? null
  );

/**
 * Reads the workspace id the authorize step signed into the install state (installOptions.metadata),
 * so the callback can build its provider from that app's credentials before handleCallback verifies the
 * state itself. Returns undefined for an invalid state or one minted without a workspace id.
 */
export function getWorkspaceIdFromInstallState(
  state: string | undefined,
  expectedNonceHash: string | null | undefined
): string | undefined {
  if (!state) return undefined;
  const result = verifyInstallState(state, expectedNonceHash);
  if (!result.valid) return undefined;
  const workspaceId = result.payload.installOptions?.metadata;
  return typeof workspaceId === 'string' && workspaceId ? workspaceId : undefined;
}

/** Stateless state store: install options are signed into a JWT instead of a server-side session. */
const createStateStore = (binding: StateBinding): StateStore => {
  // Validate JWT_SECRET is configured at initialization time
  const { jwtStateStore } = getSlackDeps();
  jwtStateStore.validateJwtSecret();

  return {
    generateStateParam: async (installUrlOptions, _date) => {
      // Sign install options into a JWT (expires in 5 minutes)
      // Uses shared JWT utilities with algorithm pinning and OIDC claims
      const { jwtStateStore } = getSlackDeps();
      return jwtStateStore.createStateToken(
        STATE_TOKEN_OPTIONS,
        { installOptions: installUrlOptions },
        binding.nonceHash
      );
    },
    verifyStateParam: async (_date, state) => {
      const result = verifyInstallState(state, binding.expectedNonceHash);

      if (result.valid) {
        return result.payload.installOptions;
      }

      // Log the specific failure reason for debugging
      Logger.warn('🔍 OAuth state verification failed', { reason: result.reason });
      throw new Error('Invalid or expired state parameter');
    },
  };
};

/** Callback-side options: `workspaceId` is the app being installed (from the signed state), when known. */
export interface InstallCallbackOptions {
  workspaceId?: string;
  onInstallComplete?: (metadata: InstallationMetadata) => void;
}

// Best-effort: a rename in Slack should refresh the stored name, but never fail an install.
async function fetchBotDisplayName(botToken?: string, botUserId?: string): Promise<string | undefined> {
  if (!botToken || !botUserId) return undefined;
  try {
    const client = new SlackClient(botToken, new Logger({ metadata: { component: 'SlackInstall' } }), {
      timeoutMs: 3000,
    });
    const user = await client.getUserInfo(botUserId);
    const name = (user?.display_name || user?.real_name || '').trim();
    if (!name) {
      Logger.warn('Could not read the Slack bot name after install; keeping the stored name', { botUserId });
    }
    return name || undefined;
  } catch (error) {
    Logger.warn('Could not read the Slack bot name after install; keeping the stored name', {
      botUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Creates the InstallProvider for one Slack app (workspace row).
 * - authorize: pass the workspaceId.
 * - callback: pass `{ workspaceId, onInstallComplete }`; without a workspaceId (an install started before the
 *   state carried one) it falls back to the first active workspace.
 */
export async function createInstallProvider(workspaceId: string, binding?: StateBinding): Promise<InstallProvider>;
export async function createInstallProvider(
  options?: InstallCallbackOptions,
  binding?: StateBinding
): Promise<InstallProvider>;
export async function createInstallProvider(
  workspaceIdOrOptions?: string | InstallCallbackOptions,
  binding: StateBinding = {}
): Promise<InstallProvider> {
  const options: InstallCallbackOptions =
    typeof workspaceIdOrOptions === 'string' ? { workspaceId: workspaceIdOrOptions } : (workspaceIdOrOptions ?? {});
  const { workspaceId, onInstallComplete } = options;
  let workspace;

  const { slackDevWorkspaceRepository } = getSlackDb() as any;

  if (workspaceId) {
    workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
  } else {
    const workspaces = await slackDevWorkspaceRepository.findAllActiveWithCredentials();
    if (workspaces.length === 0) {
      throw new Error('No Slack workspaces configured. Please create a Slack app via the admin panel first.');
    }
    workspace = workspaces[0];
    if (!workspace) {
      throw new Error('Failed to load Slack workspace configuration.');
    }
  }

  const clientId = workspace.slackClientId;
  const clientSecret = workspace.slackClientSecret;
  const expectedAppId: string | undefined = workspace.slackAppId;

  if (!clientId || !clientSecret) {
    throw new Error('Missing Slack OAuth credentials. Please ensure the Slack app was created with OAuth credentials.');
  }

  return new InstallProvider({
    clientId,
    clientSecret,
    stateStore: createStateStore(binding),
    stateVerification: true,
    // Required in @slack/oauth v3 for a custom stateStore; browser binding is our nonce hash in the signed state (packages/server-utils/src/auth/oauthFlowCookie.ts).
    legacyStateVerification: true,
    installationStore: {
      // Store installation in database
      storeInstallation: async installation => {
        const teamId = installation.team?.id;
        const teamName = installation.team?.name || 'Unknown Workspace';
        const appId = installation.appId;
        Logger.info('📦 Received Slack installation', {
          teamId,
          teamName,
          botUserId: installation.bot?.userId,
          appId,
        });

        if (!appId) {
          throw new Error('Missing app ID in installation');
        }

        if (!teamId) {
          throw new Error('Missing team ID in installation');
        }

        // With several Slack apps configured, the token must belong to the app the install was started for.
        if (workspaceId && expectedAppId !== appId) {
          Logger.error('Slack installation app ID does not match the selected workspace', {
            workspaceId,
            expectedAppId,
            receivedAppId: appId,
          });
          throw new Error('Slack app ID does not match the selected workspace');
        }

        Logger.info('📦 Storing Slack installation', {
          teamId,
          teamName,
          botUserId: installation.bot?.userId,
        });

        // Check if workspace already exists (including deactivated ones for reinstall)
        const existingWorkspace = await slackDevWorkspaceRepository.findBySlackAppId(appId);
        const isReinstall = !!existingWorkspace?.installedAt;

        if (existingWorkspace) {
          const botName = await fetchBotDisplayName(installation.bot?.token, installation.bot?.userId);

          // Update existing workspace
          await slackDevWorkspaceRepository.update({
            id: existingWorkspace.id,
            name: teamName,
            slackTeamId: teamId,
            slackBotToken: getSlackDeps().tokenEncryption.encryptToken(installation.bot?.token) || '',
            slackAppId: installation.appId || '',
            slackBotUserId: installation.bot?.userId || '',
            slackBotId: installation.bot?.id || 'UNKNOWN',
            isActive: true,
            installedAt: new Date(),
            ...(botName ? { slackBotName: botName } : {}),
          });

          Logger.info('✅ Updated existing workspace', {
            workspaceId: existingWorkspace.id,
            teamName,
          });
        } else {
          Logger.error('🔍 Workspace not found for', { teamId });
          throw new NotFoundError(`Workspace not found for team ${teamId}`);
        }

        // Notify callback handler about installation metadata
        onInstallComplete?.({ isReinstall, teamName, teamId });
      },

      // Fetch installation (required by InstallProvider but we don't use it for OAuth flow)
      fetchInstallation: async installQuery => {
        const teamId = installQuery.teamId;
        if (!teamId) {
          throw new Error('Missing team ID in install query');
        }

        const workspace = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(teamId);

        if (!workspace) {
          throw new Error(`No installation found for team ${teamId}`);
        }

        if (!workspace.slackTeamId) {
          throw new Error(
            `Workspace ${workspace.id} is missing slackTeamId. This workspace was likely created via manifest and has not completed OAuth installation yet.`
          );
        }

        if (!workspace.slackBotToken || !workspace.slackBotUserId || !workspace.slackBotId) {
          throw new Error(
            `Workspace ${workspace.id} is missing bot credentials. OAuth installation may not have completed successfully.`
          );
        }

        return {
          team: { id: workspace.slackTeamId, name: workspace.name },
          enterprise: undefined,
          user: { id: '', token: undefined, scopes: undefined },
          bot: {
            token: getSlackDeps().tokenEncryption.decryptToken(workspace.slackBotToken) || '',
            userId: workspace.slackBotUserId,
            id: workspace.slackBotId,
            scopes: SLACK_BOT_SCOPES,
          },
          appId: workspace.slackAppId,
          tokenType: 'bot' as const,
          isEnterpriseInstall: false,
        };
      },

      // Delete installation (for uninstall events)
      deleteInstallation: async installQuery => {
        const teamId = installQuery.teamId;
        if (!teamId) {
          throw new Error('Missing team ID in install query');
        }

        // Find workspace by teamId first, then deactivate by id
        const workspace = await slackDevWorkspaceRepository.findBySlackTeamIdIncludingInactive(teamId);
        if (workspace) {
          await slackDevWorkspaceRepository.deactivate(workspace.id);
          Logger.info('🗑️ Deactivated workspace', { teamId, workspaceId: workspace.id });
        }
      },
    },
  });
}

// Get install URL options for a specific workspace
export async function getInstallUrlOptionsForWorkspace(workspaceId: string): Promise<InstallURLOptions> {
  const { slackDevWorkspaceRepository } = getSlackDb() as any;
  const workspace = await slackDevWorkspaceRepository.findById(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const redirectUri = workspace.slackOAuthRedirectUri;

  if (!redirectUri) {
    throw new Error(
      'Missing Slack OAuth redirect URI in workspace configuration. Please ensure the Slack app was created properly.'
    );
  }

  // metadata is signed into the install state so the callback can resolve this same app.
  return {
    scopes: SLACK_BOT_SCOPES,
    redirectUri,
    metadata: workspaceId,
  };
}

// Get default install URL options (uses first active workspace configuration)
export async function getDefaultInstallUrlOptions(): Promise<InstallURLOptions> {
  const { slackDevWorkspaceRepository } = getSlackDb() as any;
  const workspaces = await slackDevWorkspaceRepository.findAllActive();
  if (workspaces.length === 0) {
    throw new Error('No Slack workspaces configured. Please create a Slack app via the admin panel first.');
  }

  return getInstallUrlOptionsForWorkspace(workspaces[0].id);
}
