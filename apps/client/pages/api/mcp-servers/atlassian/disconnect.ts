import { baseApi } from '@server/middlewares/baseApi';
import { userRepository, jiraWebhookConfigRepository, jiraWebhookSubscriptionRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { McpServer } from '@bike4mind/database/ai';
import { getAtlassianOAuthConfig } from '@server/integrations/jira/atlassianConfig';
import { decryptToken } from '@server/security/tokenEncryption';

const handler = baseApi().delete(async (req, res) => {
  try {
    // Fetch current Atlassian connection to revoke tokens
    const user = await userRepository.findById(req.user.id);
    const atlassianConnect = user?.atlassianConnect;

    if (atlassianConnect?.accessToken) {
      try {
        const { clientId, clientSecret } = await getAtlassianOAuthConfig();

        if (clientId && clientSecret) {
          console.log('[Atlassian Disconnect] 🔄 Revoking OAuth token with Atlassian...');

          const revokeResponse = await fetch('https://auth.atlassian.com/oauth/token/revoke', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              token: decryptToken(atlassianConnect.accessToken) ?? '',
            }),
          });

          if (revokeResponse.ok) {
            console.log('[Atlassian Disconnect] ✅ OAuth token revoked successfully');
          } else {
            const errorText = await revokeResponse.text();
            console.warn('[Atlassian Disconnect] ⚠️ Failed to revoke token:', errorText);
          }
        }
      } catch (revokeError) {
        // Log but don't fail disconnect if revocation fails
        console.error('[Atlassian Disconnect] ❌ Token revocation failed:', revokeError);
      }
    }

    // Clean up Jira webhook configs and subscriptions for all connected resources
    if (atlassianConnect?.resources) {
      for (const resource of atlassianConnect.resources) {
        try {
          const webhookConfig = await jiraWebhookConfigRepository.findByAtlassianCloudId(resource.id);
          if (webhookConfig) {
            const deletedSubs = await jiraWebhookSubscriptionRepository.deleteByWebhookConfig(webhookConfig.id);
            await jiraWebhookConfigRepository.delete(webhookConfig.id);
            console.log(
              `[Atlassian Disconnect] ✅ Deleted webhook config and ${deletedSubs} subscription(s) for cloud ${resource.id}`
            );
          }
        } catch (webhookError) {
          console.error(
            `[Atlassian Disconnect] ❌ Failed to clean up webhooks for cloud ${resource.id}:`,
            webhookError
          );
        }
      }
    }

    // Removing the connection from the User model is the main requirement; MCP server cleanup below is best-effort
    await userRepository.update({
      id: req.user.id,
      atlassianConnect: null,
    });

    // Remove Atlassian MCP server using Mongoose's findOneAndDelete (hard delete)
    try {
      const deletedMcpServer = await McpServer.findOneAndDelete({
        name: McpServerName.Atlassian,
        userId: req.user.id,
      });

      if (deletedMcpServer) {
        console.log('[Atlassian Disconnect] ✅ MCP server permanently deleted.');
      } else {
        console.log('[Atlassian Disconnect] ⚠️ No Atlassian MCP server found - nothing to delete');
      }
    } catch (mcpError) {
      // Log the MCP error but don't fail the disconnect operation
      console.error('[Atlassian Disconnect] ❌ Failed to delete Atlassian MCP server:', mcpError);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Atlassian Disconnect] ❌ Fatal error during disconnect:', error);
    res.status(500).json({
      error: 'Failed to disconnect Atlassian',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default handler;
