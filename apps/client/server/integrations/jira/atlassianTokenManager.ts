import { userRepository, mcpServerRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { getAtlassianOAuthConfig } from '@server/integrations/jira/atlassianConfig';
import { encryptToken, decryptToken, encryptEnvVariables } from '@server/security/tokenEncryption';

/**
 * Custom error class for Atlassian reconnection required scenarios.
 * Used to distinguish expected token expiration from unexpected errors.
 */
export class AtlassianReconnectRequiredError extends Error {
  constructor(message = 'Your Atlassian connection has expired. Please reconnect your account.') {
    super(message);
    this.name = 'AtlassianReconnectRequiredError';
  }
}

interface TokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  cloudId: string;
  siteUrl: string;
}

export class AtlassianTokenManager {
  private static async refreshToken(userId: string): Promise<TokenRefreshResult> {
    const user = await userRepository.findById(userId);

    if (!user || !user.atlassianConnect) {
      throw new Error('Atlassian connection not found');
    }

    const { clientId, clientSecret } = await getAtlassianOAuthConfig();

    if (!clientId || !clientSecret) {
      throw new Error('Atlassian OAuth credentials not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout for OAuth

    let response: Response;
    try {
      response = await fetch('https://auth.atlassian.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: decryptToken(user.atlassianConnect.refreshToken),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new Error('Atlassian token refresh timed out after 30s');
      }
      throw fetchError;
    }

    if (!response.ok) {
      const errorText = await response.text();

      const isInvalidRefreshToken =
        errorText.includes('invalid') || errorText.includes('expired') || errorText.includes('unauthorized_client');

      if (isInvalidRefreshToken) {
        console.log('🔴 Atlassian refresh token is invalid/expired. Marking for reconnection.');
        await userRepository.update({
          id: userId,
          atlassianConnect: {
            ...user.atlassianConnect,
            status: 'needs_reconnect',
            disconnectReason: 'Your Atlassian connection has expired. Please reconnect your account.',
          },
        });

        throw new AtlassianReconnectRequiredError();
      }

      throw new Error(`Token refresh failed: ${errorText}`);
    }

    const tokenData = await response.json();
    const nextRefreshToken = tokenData.refresh_token ?? user.atlassianConnect.refreshToken;
    if (!nextRefreshToken) {
      throw new Error('Refresh token missing from Atlassian response');
    }
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    const updatedConnection = {
      ...user.atlassianConnect,
      accessToken: encryptToken(tokenData.access_token)!,
      refreshToken: encryptToken(nextRefreshToken)!,
      expiresAt,
      status: 'connected' as const,
      disconnectReason: undefined,
    };

    await userRepository.update({
      id: userId,
      atlassianConnect: updatedConnection,
    });

    // Also update Atlassian MCP server environment variables
    // Use the selected resource, not the first one in the array
    const selectedResourceId = user.atlassianConnect.selectedResourceId;
    const selectedResource = selectedResourceId
      ? user.atlassianConnect.resources?.find(r => r.id === selectedResourceId)
      : user.atlassianConnect.resources?.[0]; // Fallback for legacy users without selectedResourceId

    if (!selectedResource) {
      throw new Error('No Atlassian resource found');
    }

    const siteUrl = selectedResource.url?.endsWith('/wiki') ? selectedResource.url : `${selectedResource.url}/wiki`;

    const atlassianServer = await mcpServerRepository.findOne({
      name: McpServerName.Atlassian,
      userId,
    });

    if (atlassianServer) {
      await mcpServerRepository.update({
        id: atlassianServer.id,
        envVariables: encryptEnvVariables([
          { key: 'ATLASSIAN_ACCESS_TOKEN', value: tokenData.access_token },
          { key: 'ATLASSIAN_CLOUD_ID', value: selectedResource.id },
          { key: 'ATLASSIAN_SITE_URL', value: siteUrl },
        ]),
      });
      console.log(
        `✅ Updated Atlassian MCP server with refreshed tokens (site: ${selectedResource.name || selectedResource.id})`
      );
    }

    return {
      accessToken: tokenData.access_token,
      refreshToken: nextRefreshToken,
      expiresAt,
      cloudId: selectedResource.id,
      siteUrl,
    };
  }

  /**
   * Ensures a valid access token is available, refreshing if necessary.
   * Returns just the access token string for simple use cases.
   * Throws error if tokens cannot be retrieved.
   */
  static async ensureValidToken(userId: string): Promise<string> {
    const result = await this.getValidTokens(userId);
    if (!result) {
      throw new Error('Failed to get valid Atlassian tokens');
    }
    return result.accessToken;
  }

  /**
   * Gets all valid tokens with metadata (cloudId, siteUrl).
   * Automatically refreshes if tokens expire within 5 minutes.
   * Returns null on error instead of throwing.
   */
  static async getValidTokens(
    userId: string
  ): Promise<{ accessToken: string; refreshToken: string; cloudId: string; siteUrl: string } | null> {
    try {
      const user = await userRepository.findById(userId);

      if (!user || !user.atlassianConnect) {
        console.warn('⚠️ Atlassian connection not found for user:', userId);
        return null;
      }

      const { atlassianConnect } = user;

      if (atlassianConnect.status === 'needs_reconnect') {
        throw new AtlassianReconnectRequiredError();
      }
      const now = new Date();
      const tokenExpiresIn = atlassianConnect.expiresAt.getTime() - now.getTime();

      // Use the selected resource, not the first one in the array
      const selectedResourceId = atlassianConnect.selectedResourceId;
      const selectedResource = selectedResourceId
        ? atlassianConnect.resources?.find(r => r.id === selectedResourceId)
        : atlassianConnect.resources?.[0]; // Fallback for legacy users without selectedResourceId

      if (!selectedResource) {
        console.warn('⚠️ No Atlassian resource found for user:', userId);
        return null;
      }

      const siteUrl = selectedResource.url?.endsWith('/wiki') ? selectedResource.url : `${selectedResource.url}/wiki`;

      if (tokenExpiresIn >= 5 * 60 * 1000) {
        console.log(`✅ Using existing valid Atlassian token (site: ${selectedResource.name || selectedResource.id})`);
        return {
          accessToken: decryptToken(atlassianConnect.accessToken)!,
          refreshToken: decryptToken(atlassianConnect.refreshToken)!,
          cloudId: selectedResource.id,
          siteUrl,
        };
      }

      console.log('🔄 Refreshing Atlassian token (expires soon)');
      const refreshed = await this.refreshToken(userId);
      return {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        cloudId: refreshed.cloudId,
        siteUrl: refreshed.siteUrl,
      };
    } catch (error) {
      if (error instanceof AtlassianReconnectRequiredError) {
        throw error;
      }
      console.error('❌ Error in getValidTokens:', error);
      return null;
    }
  }
}
