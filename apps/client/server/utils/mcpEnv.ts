import { IGitHubRepository, IMcpServerDocument, McpServerName } from '@bike4mind/common';
import {
  GITHUB_REPOSITORY_FULL_NAME_PATTERN,
  GITHUB_SELECTED_REPOSITORIES_ENV_KEY,
} from '@bike4mind/mcp/github/constants';
import { userRepository } from '@bike4mind/database';
import {
  AtlassianTokenManager,
  AtlassianReconnectRequiredError,
} from '@bike4mind/server-utils/integrations/jira/atlassianTokenManager';
import { decryptEnvVariables } from '@bike4mind/server-utils/security/tokenEncryption';

export type EnvVariable = { key: string; value: string };

/**
 * Builds the environment variables required for a given MCP server before invoking the Lambda handler.
 * Handles provider-specific requirements (e.g., Atlassian token refresh) while falling back to the
 * stored server configuration for generic providers.
 */
export const buildMcpEnvVariables = async (mcpServer: IMcpServerDocument): Promise<EnvVariable[]> => {
  if (mcpServer.name === 'atlassian' && mcpServer.userId) {
    const user = await userRepository.findById(mcpServer.userId);

    // No connection at all - user disconnected or never completed setup.
    // Throw AtlassianReconnectRequiredError so the tools layer catches it.
    // At getTools time: returns empty tool list. At callTool time: returns reconnect message.
    if (!user?.atlassianConnect) {
      console.log(`Atlassian connection missing for user ${mcpServer.userId} — prompting reconnect`);
      throw new AtlassianReconnectRequiredError(
        'Your Atlassian account is not connected. Please connect it in Settings > Connected Apps.'
      );
    }

    const validTokens = await AtlassianTokenManager.getValidTokens(mcpServer.userId);

    if (!validTokens) {
      // Fallback: Use stored environment variables if token refresh fails.
      // Stored tokens may also be expired - the MCP call will fail and the tools layer will prompt reconnection.
      if (Array.isArray(mcpServer.envVariables) && mcpServer.envVariables.length > 0) {
        console.warn('⚠️ Atlassian token refresh failed, falling back to stored tokens');
        return decryptEnvVariables(mcpServer.envVariables, mcpServer);
      }

      throw new AtlassianReconnectRequiredError(
        'Unable to refresh Atlassian tokens. Please reconnect your Atlassian account in Settings > Connected Apps.'
      );
    }

    return [
      { key: 'ATLASSIAN_ACCESS_TOKEN', value: validTokens.accessToken },
      { key: 'ATLASSIAN_CLOUD_ID', value: validTokens.cloudId },
      { key: 'ATLASSIAN_SITE_URL', value: validTokens.siteUrl },
    ];
  }

  const storedEnvVariables = Array.isArray(mcpServer.envVariables)
    ? decryptEnvVariables(mcpServer.envVariables, mcpServer)
    : [];

  if (mcpServer.name === McpServerName.Github) {
    return withGitHubRepositorySelection(storedEnvVariables, mcpServer.metadata?.selectedRepositories);
  }

  return storedEnvVariables;
};

/**
 * The GitHub server enforces the user's repository selection from this variable. It is derived from
 * metadata on every spawn, never taken from stored env, so the saved selection is the only source.
 * An empty selection means the user has not restricted access, so the variable is omitted.
 */
function withGitHubRepositorySelection(
  envVariables: EnvVariable[],
  selectedRepositories: IGitHubRepository[] | undefined
): EnvVariable[] {
  const withoutStoredSelection = envVariables.filter(({ key }) => key !== GITHUB_SELECTED_REPOSITORIES_ENV_KEY);
  if (!selectedRepositories?.length) return withoutStoredSelection;

  // Rows saved before the route validated the shape can hold a name the server cannot parse. Drop
  // those rather than hand the server a value that stops it starting. If nothing valid remains the
  // empty list still restricts: an unknown selection must not widen access to every repository.
  const fullNames = selectedRepositories
    .map(({ fullName }) => fullName)
    .filter(fullName => {
      if (GITHUB_REPOSITORY_FULL_NAME_PATTERN.test(fullName)) return true;
      console.warn(`Ignoring saved GitHub repository "${fullName}": not an "owner/repo" name`);
      return false;
    });

  return [...withoutStoredSelection, { key: GITHUB_SELECTED_REPOSITORIES_ENV_KEY, value: JSON.stringify(fullNames) }];
}
