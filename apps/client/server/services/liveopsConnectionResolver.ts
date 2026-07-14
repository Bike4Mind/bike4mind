/**
 * LiveOps Triage connection resolution
 *
 * Resolves the Slack bot token and Jira configuration for a triage config.
 * Org-scoped configs (config.organizationId set) resolve strictly from that
 * organization's connections (OrgSlackWorkspace, OrgJiraConnection) with NO
 * system-level fallback, so one org's triage can never read or write another
 * org's connected systems. Legacy configs (no organizationId) keep the
 * original system-level behavior (SlackDevWorkspace / ATLASSIAN_* env vars).
 *
 * GitHub follows the same rule inside GitHubIssueTracker via
 * GitHubService.forOrganization vs forSystem.
 */

import type { Logger } from '@bike4mind/observability';
import type { JiraConfig } from '@bike4mind/common/jira/api';
import { getAtlassianConfig, buildAtlassianConfig } from '@bike4mind/common/atlassian/config';
import {
  ILiveopsTriageConfigDocument,
  orgJiraConnectionRepository,
  orgSlackWorkspaceRepository,
  slackDevWorkspaceRepository,
} from '@bike4mind/database';
import { decryptToken } from '@server/security/tokenEncryption';
import { decryptSecret, isEncrypted } from '@server/security/secretEncryption';
import { Config } from '@server/utils/config';

/**
 * Resolve the Slack bot token for a triage config.
 * Returns null when no usable workspace/token is found.
 */
export async function resolveSlackBotToken(
  config: Pick<ILiveopsTriageConfigDocument, 'organizationId' | 'slackWorkspaceId' | 'name'>,
  logger: Logger
): Promise<string | null> {
  if (config.organizationId) {
    const workspace = await orgSlackWorkspaceRepository.findByOrganizationIdWithToken(config.organizationId);
    const token = decryptToken(workspace?.slackBotToken) ?? null;
    if (token) {
      logger.info('[LIVEOPS-CONNECTIONS] Using org Slack workspace', {
        organizationId: config.organizationId,
        configName: config.name,
      });
    } else {
      // Isolation: org-scoped configs never fall back to system-level workspaces
      logger.warn('[LIVEOPS-CONNECTIONS] No enabled Slack workspace for organization', {
        organizationId: config.organizationId,
        configName: config.name,
      });
    }
    return token;
  }

  let slackBotToken: string | null = null;

  if (config.slackWorkspaceId) {
    const workspace = await slackDevWorkspaceRepository.findByIdWithToken(String(config.slackWorkspaceId));
    if (workspace) {
      slackBotToken = decryptToken(workspace.slackBotToken) ?? null;
      logger.info('[LIVEOPS-CONNECTIONS] Using configured Slack workspace', {
        workspaceId: config.slackWorkspaceId,
        configName: config.name,
      });
    } else {
      logger.warn('[LIVEOPS-CONNECTIONS] Configured workspace not found, falling back to first active', {
        configuredWorkspaceId: config.slackWorkspaceId,
        configName: config.name,
      });
    }
  }

  // Fallback to first active workspace (legacy system-level configs only)
  if (!slackBotToken) {
    const activeWorkspaces = await slackDevWorkspaceRepository.findAllActive();
    if (activeWorkspaces.length > 0 && activeWorkspaces[0].slackTeamId) {
      const workspaceWithToken = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(
        activeWorkspaces[0].slackTeamId
      );
      slackBotToken = decryptToken(workspaceWithToken?.slackBotToken) ?? null;
      if (slackBotToken) {
        logger.warn('[LIVEOPS-CONNECTIONS] Using first active workspace as fallback', {
          workspaceId: activeWorkspaces[0].id,
          configName: config.name,
        });
      }
    }
  }

  return slackBotToken;
}

/**
 * Resolve the Jira configuration for a triage config.
 * Org-scoped configs use the org's OrgJiraConnection; legacy configs use the
 * ATLASSIAN_* environment variables.
 *
 * @throws Error when the org has no enabled Jira connection or credentials
 *   cannot be decrypted (never falls back to system credentials).
 */
export async function resolveJiraConfig(
  organizationId: string | null | undefined,
  logger: Logger
): Promise<JiraConfig> {
  if (!organizationId) {
    return getAtlassianConfig().jira;
  }

  const connection = await orgJiraConnectionRepository.findByOrganizationIdWithCredentials(organizationId);
  if (!connection?.accessToken) {
    logger.warn('[LIVEOPS-CONNECTIONS] No enabled Jira connection for organization', { organizationId });
    throw new Error('No enabled Jira connection found for organization');
  }

  const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    logger.error('[LIVEOPS-CONNECTIONS] SECRET_ENCRYPTION_KEY not configured - cannot decrypt Jira credentials');
    throw new Error('Jira connection configuration error. Please contact administrator.');
  }

  let accessToken = connection.accessToken;
  if (isEncrypted(accessToken)) {
    try {
      accessToken = decryptSecret(accessToken, encryptionKey);
    } catch {
      // Never expose decryption errors - they may reveal encryption structure
      throw new Error('Failed to decrypt Jira credentials. Key may need rotation.');
    }
  }

  return buildAtlassianConfig({ accessToken, cloudId: connection.cloudId, siteUrl: connection.siteUrl }).jira;
}
