import { InstallProvider, InstallURLOptions, StateStore } from '@slack/oauth';
import { NotFoundError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { getSlackDeps, getSlackDb } from './di/registry';
import type { BaseStatePayload } from './di/types';
import { getControlledScopes } from './manifestTemplate';

// Slack-specific audience for state tokens
const SLACK_AUDIENCE = 'slack-oauth-state' as const;

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

/**
 * Custom state store for serverless environments
 * Uses signed JWT instead of cookies (which don't persist across Lambda invocations)
 * This is the industry-standard approach for stateless OAuth in serverless architectures
 */
const createStateStore = (): StateStore => {
  // Validate JWT_SECRET is configured at initialization time
  const { jwtStateStore } = getSlackDeps();
  jwtStateStore.validateJwtSecret();

  const options = { audience: SLACK_AUDIENCE };

  return {
    generateStateParam: async (installUrlOptions, _date) => {
      // Sign install options into a JWT (expires in 5 minutes)
      // Uses shared JWT utilities with algorithm pinning and OIDC claims
      const { jwtStateStore } = getSlackDeps();
      return jwtStateStore.createStateToken(options, { installOptions: installUrlOptions });
    },
    verifyStateParam: async (_date, state) => {
      const { jwtStateStore } = getSlackDeps();
      const result = jwtStateStore.verifyStateToken<SlackStatePayload>(state, options);

      if (result.valid) {
        return result.payload.installOptions;
      }

      // Log the specific failure reason for debugging
      Logger.warn('🔍 OAuth state verification failed', { reason: result.reason });
      throw new Error('Invalid or expired state parameter');
    },
  };
};

// Create InstallProvider instance with metadata callback
export async function createInstallProvider(
  workspaceIdOrCallback?: string | ((metadata: InstallationMetadata) => void)
): Promise<InstallProvider> {
  let workspace;
  let onInstallComplete: ((metadata: InstallationMetadata) => void) | undefined;

  const { slackDevWorkspaceRepository } = getSlackDb() as any;

  // Handle overloaded parameters
  if (typeof workspaceIdOrCallback === 'string') {
    // workspaceId provided
    workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(workspaceIdOrCallback);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceIdOrCallback}`);
    }
  } else {
    // Callback provided or no params - use first active workspace (backward compatibility)
    onInstallComplete = workspaceIdOrCallback;
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

  if (!clientId || !clientSecret) {
    throw new Error('Missing Slack OAuth credentials. Please ensure the Slack app was created with OAuth credentials.');
  }

  return new InstallProvider({
    clientId,
    clientSecret,
    stateStore: createStateStore(),
    stateVerification: true,
    // legacyStateVerification is REQUIRED to use custom stateStore in @slack/oauth v3
    // Without it, the library defaults to cookie-based verification which doesn't work in serverless
    // Our JWT-based state store provides proper CSRF protection via signed tokens
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

        Logger.info('📦 Storing Slack installation', {
          teamId,
          teamName,
          botUserId: installation.bot?.userId,
        });

        // Check if workspace already exists (including deactivated ones for reinstall)
        const existingWorkspace = await slackDevWorkspaceRepository.findBySlackAppId(appId);
        const isReinstall = !!existingWorkspace?.installedAt;

        if (existingWorkspace) {
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

  return {
    scopes: SLACK_BOT_SCOPES,
    redirectUri,
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
