import { McpServer } from '@bike4mind/database/ai';
import { NotFoundError } from '@bike4mind/utils';
import { MCPClient } from '@bike4mind/mcp';
import { baseApi } from '@server/middlewares/baseApi';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { encryptEnvVariables, decryptEnvVariables } from '@server/security/tokenEncryption';

const handler = baseApi()
  .delete(async (req, res) => {
    const { id } = req.query;

    const server = await McpServer.findOneAndDelete({
      _id: id,
      userId: req.user.id, // Ensure user owns the server
    });

    if (!server) {
      throw new NotFoundError('MCP Server not found for id: ' + id);
    }

    return res.status(204).end();
  })
  .put(async (req, res) => {
    const { id } = req.query;

    const { name, envVariables, enabled } = req.body;
    const server = await McpServer.findById(id);

    if (!server) {
      throw new NotFoundError('MCP Server not found for id: ' + id);
    }

    // Verify user owns the server (IDOR protection)
    if (server.userId !== req.user.id) {
      throw new ForbiddenError('Not authorized to modify this MCP server');
    }

    // Config changed, so clear cached tool schemas
    const updatedServer = await McpServer.findOneAndUpdate(
      { _id: id, userId: req.user.id }, // Ensure user owns the server
      { $set: { name, envVariables: encryptEnvVariables(envVariables), enabled }, $unset: { toolSchemas: '' } },
      { new: true, runValidators: true }
    );

    return res.status(200).json(updatedServer);
  })
  .get(async (req, res) => {
    const { id } = req.query;
    const server = await McpServer.findOne({ _id: id, userId: req.user.id });
    if (!server) {
      return res.status(404).json({ message: 'Server not found' });
    }

    try {
      const result = await invokeMcpHandler<MCPClient['tools']>({
        envVariables: decryptEnvVariables(server.envVariables),
        name: server.name,
        action: 'getTools',
        userId: req.user.id,
      });

      return res.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect to MCP server.';
      throw new BadRequestError('Unable to connect to MCP server', { reason: message });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
