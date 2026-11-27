import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { McpServer } from '@bike4mind/database/ai';

/**
 * Disconnects the Notion integration for the current user.
 *
 * DELETE /api/mcp-servers/notion/disconnect
 *
 * Notion does expose a revocation endpoint (POST /v1/oauth/revoke), but this handler
 * does not call it yet: it only removes our copy of the credentials. The token stays
 * valid until the user removes the integration from Notion's settings page, which the
 * response message tells them how to do.
 */
const handler = baseApi().delete(async (req, res) => {
  try {
    const userId = req.user.id;

    await userRepository.update({
      id: userId,
      notionConnect: null,
      pendingNotionOAuthNonce: null,
    });

    // Remove Notion MCP server using Mongoose's findOneAndDelete (hard delete)
    try {
      const deletedMcpServer = await McpServer.findOneAndDelete({
        name: McpServerName.Notion,
        userId,
      });

      req.logger.info('Notion disconnect MCP server cleanup', { userId, deleted: Boolean(deletedMcpServer) });
    } catch (mcpError) {
      // Log the MCP error but don't fail the disconnect operation
      req.logger.error('Notion disconnect MCP server delete failed', { userId, error: mcpError });
    }

    res.status(200).json({
      success: true,
      message:
        'Notion disconnected from Bike4Mind. Note: the token may still be valid in Notion until you revoke it ' +
        'at notion.so > Settings & members > My connections.',
    });
  } catch (error) {
    req.logger.error('Notion disconnect failed', { userId: req.user.id, error });
    const detail = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({
      error: `Failed to disconnect Notion: ${detail}. Please try again or contact support.`,
    });
  }
});

export default handler;
