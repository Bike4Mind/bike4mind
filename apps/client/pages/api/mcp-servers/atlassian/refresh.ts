import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { userRepository, mcpServerRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { getAtlassianOAuthConfig } from '@server/integrations/jira/atlassianConfig';
import { encryptToken, decryptToken, encryptEnvVariables } from '@server/security/tokenEncryption';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

const handler = baseApi().post(async (req, res) => {
  const user = await userRepository.findById(req.user.id);

  if (!user || !user.atlassianConnect) {
    throw new NotFoundError('Atlassian connection not found');
  }

  const { clientId, clientSecret } = await getAtlassianOAuthConfig();

  if (!clientId || !clientSecret) {
    throw new BadRequestError('Atlassian OAuth credentials not configured');
  }

  try {
    const tokenResponse = await fetch('https://auth.atlassian.com/oauth/token', {
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
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const tokenData: TokenResponse = await tokenResponse.json();
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
    };

    await userRepository.update({
      id: req.user.id,
      atlassianConnect: updatedConnection,
    });

    // Also update MCP server environment variables
    const server = await mcpServerRepository.findOne({
      name: McpServerName.Atlassian,
      userId: req.user.id,
    });

    if (server) {
      const primaryResource = user.atlassianConnect.resources?.[0];
      if (!primaryResource) {
        throw new Error('No Atlassian resource found');
      }

      const siteUrl = primaryResource.url?.endsWith('/wiki') ? primaryResource.url : `${primaryResource.url}/wiki`;

      await mcpServerRepository.update({
        id: server.id,
        envVariables: encryptEnvVariables([
          { key: 'ATLASSIAN_ACCESS_TOKEN', value: tokenData.access_token },
          { key: 'ATLASSIAN_CLOUD_ID', value: primaryResource.id },
          { key: 'ATLASSIAN_SITE_URL', value: siteUrl },
        ]),
      });
    }

    res.json({
      success: true,
      expiresAt,
      accessToken: tokenData.access_token,
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    throw new BadRequestError(`Failed to refresh token: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

export default handler;
