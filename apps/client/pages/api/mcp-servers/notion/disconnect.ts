import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { McpServer } from '@bike4mind/database/ai';

/**
 * Disconnects the Notion integration for the current user.
 *
 * DELETE /api/mcp-servers/notion/disconnect
 *
 * Unlike some OAuth providers, Notion doesn't have a token revocation endpoint.
 * The token will remain valid until the user removes the integration from
 * Notion's settings page, but we remove it from our system.
 */
const handler = baseApi().delete(async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch current Notion connection info for logging
    const user = await userRepository.findById(userId);
    const notionConnect = user?.notionConnect;

    if (notionConnect) {
      console.log(
        `[Notion Disconnect] Disconnecting workspace: ${notionConnect.workspaceName} (${notionConnect.workspaceId})`
      );
    }

    await userRepository.update({
      id: userId,
      notionConnect: null,
    });

    console.log(`[Notion Disconnect] Removed notionConnect for user ${userId}`);

    // Remove Notion MCP server using Mongoose's findOneAndDelete (hard delete)
    try {
      const deletedMcpServer = await McpServer.findOneAndDelete({
        name: McpServerName.Notion,
        userId,
      });

      if (deletedMcpServer) {
        console.log('[Notion Disconnect] MCP server permanently deleted.');
      } else {
        console.log('[Notion Disconnect] No Notion MCP server found - nothing to delete');
      }
    } catch (mcpError) {
      // Log the MCP error but don't fail the disconnect operation
      console.error('[Notion Disconnect] Failed to delete Notion MCP server:', mcpError);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Notion Disconnect] Fatal error during disconnect:', error);
    res.status(500).json({
      error: 'Failed to disconnect Notion',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default handler;
