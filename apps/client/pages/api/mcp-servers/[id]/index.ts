import { McpServer } from '@bike4mind/database/ai';
import { mcpServerResponseSchema } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { MCPClient } from '@bike4mind/mcp';
import { baseApi } from '@server/middlewares/baseApi';
import { assertMcpServerEnabled } from '@server/utils/mcpServerFlag';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { encryptEnvVariables, decryptEnvVariables } from '@server/security/tokenEncryption';
import { mcpServerUpdateBodySchema } from '@server/validators/mcpServerValidators';
import { assertNoForbiddenMcpEnvKeys } from '@server/utils/mcpEnvValidation';
import { isValidObjectId } from '@server/utils/objectId';
import { respond } from '@server/utils/respond';

const handler = baseApi()
  .delete(async (req, res) => {
    const { id } = req.query;

    const server = isValidObjectId(id)
      ? await McpServer.findOneAndDelete({
          _id: id,
          userId: req.user.id, // Ensure user owns the server
        })
      : null;

    if (!server) {
      throw new NotFoundError('MCP Server not found for id: ' + id);
    }

    return res.status(204).end();
  })
  .put(async (req, res) => {
    await assertMcpServerEnabled();
    const { id } = req.query;

    const parsedBody = mcpServerUpdateBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new BadRequestError('Invalid request body');
    }
    const { name, envVariables, enabled } = parsedBody.data;
    assertNoForbiddenMcpEnvKeys(envVariables);

    const server = isValidObjectId(id) ? await McpServer.findById(id) : null;

    if (!server) {
      throw new NotFoundError('MCP Server not found for id: ' + id);
    }

    // Verify user owns the server (IDOR protection)
    if (server.userId !== req.user.id) {
      throw new ForbiddenError('Not authorized to modify this MCP server');
    }

    // A blank value means "unchanged": the client never receives stored values, only keys. A
    // blank key that is not stored yet has nothing to keep, so it is refused rather than saved empty.
    const storedValues = new Map(server.envVariables.map(v => [v.key, v.value]));
    const mergedEnvVariables = envVariables.map(({ key, value }) => {
      if (value) return { key, value };
      const storedValue = storedValues.get(key);
      if (storedValue === undefined) {
        throw new BadRequestError('A value is required for a new environment variable', { key });
      }
      return { key, value: storedValue };
    });

    // Config changed, so clear cached tool schemas
    const updatedServer = await McpServer.findOneAndUpdate(
      { _id: id, userId: req.user.id }, // Ensure user owns the server
      {
        $set: { name, envVariables: encryptEnvVariables(mergedEnvVariables), enabled },
        $unset: { toolSchemas: '', toolSchemasFetchedAt: '' },
      },
      { new: true, runValidators: true }
    );

    if (!updatedServer) {
      throw new NotFoundError('MCP Server not found for id: ' + id);
    }

    return respond(res, mcpServerResponseSchema, updatedServer.toJSON());
  })
  .get(async (req, res) => {
    await assertMcpServerEnabled();
    const { id } = req.query;
    const server = isValidObjectId(id) ? await McpServer.findOne({ _id: id, userId: req.user.id }) : null;
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
