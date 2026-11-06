import { McpServer } from '@bike4mind/database/ai';
import { mcpServerResponseSchema } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { MCPClient } from '@bike4mind/mcp';
import { baseApi } from '@server/middlewares/baseApi';
import { assertMcpServerEnabled } from '@server/utils/mcpServerFlag';
import { invokeMcpHandler } from '@bike4mind/server-utils/utils/invokeMcpHandler';
import { BadRequestError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { encryptEnvVariables, decryptEnvVariables } from '@bike4mind/server-utils/security/tokenEncryption';
import { mcpServerUpdateBodySchema } from '@server/validators/mcpServerValidators';
import { assertNoForbiddenMcpEnvKeys } from '@server/utils/mcpEnvValidation';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
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
    // A legacy row can hold a null (or malformed) envVariables array; read it as empty rather
    // than throwing on `.map`.
    const storedVariables = Array.isArray(server.envVariables) ? server.envVariables : [];
    const storedValues = new Map(
      storedVariables
        .filter(variable => typeof variable?.key === 'string')
        .map(variable => [variable.key, variable.value] as const)
    );
    const mergedEnvVariables = envVariables.map(({ key, value }) => {
      if (value) return { key, value };
      const storedValue = storedValues.get(key);
      if (storedValue === undefined) {
        throw new BadRequestError('A value is required for a new environment variable', { key });
      }
      return decryptEnvVariables([{ key, value: storedValue }], server)[0];
    });

    // Config changed, so clear cached tool schemas
    const updatedServer = await McpServer.findOneAndUpdate(
      { _id: id, userId: req.user.id }, // Ensure user owns the server
      {
        $set: {
          name,
          envVariables: encryptEnvVariables(mergedEnvVariables, { userId: server.userId, name, id: server.id }),
          enabled,
        },
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
        envVariables: decryptEnvVariables(server.envVariables, server),
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
