import { McpServer, mcpServerRepository } from '@bike4mind/database/ai';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/utils';
import { MCPClient } from '@bike4mind/mcp';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { BadRequestError } from '@server/utils/errors';
import { decryptEnvVariables } from '@server/security/tokenEncryption';
import { isValidObjectId } from '@server/utils/objectId';
import { buildMcpToolCacheUpdate } from '@bike4mind/services/llm';

const handler = baseApi().post(async (req, res) => {
  const { id } = req.query;
  const server = isValidObjectId(id) ? await McpServer.findOne({ _id: id, userId: req.user.id }) : null;
  if (!server) {
    throw new NotFoundError('Server not found');
  }

  let result: MCPClient['tools'] = [];

  // Reconnect invalidates any prior "confirmed empty" marker: clear it before the fetch so a
  // failed reconnect retries next turn instead of trusting a stale empty cache.
  await mcpServerRepository.update({ id: server.id }, { unset: ['toolSchemasFetchedAt'] });

  try {
    const invoked = await invokeMcpHandler<MCPClient['tools']>({
      envVariables: decryptEnvVariables(server.envVariables),
      name: server.name,
      action: 'getTools',
    });
    if (Array.isArray(invoked)) {
      result = invoked;
    } else if (invoked) {
      result = [invoked].flat() as MCPClient['tools'];
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to connect to MCP server.';
    throw new BadRequestError('Unable to connect to MCP server', { reason: message });
  }

  await mcpServerRepository.update(buildMcpToolCacheUpdate(server.id, result));

  return res.status(200).json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
