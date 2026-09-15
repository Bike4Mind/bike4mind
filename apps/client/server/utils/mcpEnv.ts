import { IMcpServerDocument } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import {
  AtlassianTokenManager,
  AtlassianReconnectRequiredError,
} from '@server/integrations/jira/atlassianTokenManager';
import { decryptEnvVariables } from '@server/security/tokenEncryption';

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
        return decryptEnvVariables(mcpServer.envVariables);
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

  return Array.isArray(mcpServer.envVariables) ? decryptEnvVariables(mcpServer.envVariables) : [];
};
