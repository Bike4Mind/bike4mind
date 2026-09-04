import { McpServer } from '@bike4mind/database/ai';
import { NotFoundError } from '@bike4mind/utils';
import { MCPClient } from '@bike4mind/mcp';
import { baseApi } from '@server/middlewares/baseApi';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { encryptEnvVariables, decryptEnvVariables } from '@server/security/tokenEncryption';
import { z } from 'zod';

// These three go into a `$set`, and update payloads cast before validators run. `enabled` is
// Boolean-typed: mongoose accepts true/'true'/1/'1' but throws `CastError kind='Boolean'` on
// 2, {} or [], and `name` is a String path that throws on an array or object. This route is
// NOT admin-gated - the only check is the IDOR ownership test below - so an authenticated
// caller could otherwise turn a body value into a 500 logged at `error`.
//
// z.boolean() rather than a coercion, deliberately: coercing would accept 2 and hand it to
// mongoose, which is the thing being guarded against. Types only, not enum membership -- an
// out-of-enum `name` is a mongoose *validator* failure (ValidationError), not a cast, so it
// answers 500 both before and after this change and is out of scope here.
const updateBodySchema = z.object({
  name: z.string().optional(),
  // Required because encryptEnvVariables() maps over it unconditionally: a body without it
  // throws a TypeError today, so declaring it required turns that 500 into a 400 and breaks
  // no call that currently works.
  envVariables: z.array(z.object({ key: z.string(), value: z.string() })),
  enabled: z.boolean().optional(),
});

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

    const parsedBody = updateBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new BadRequestError('Invalid request body');
    }
    const { name, envVariables, enabled } = parsedBody.data;

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
