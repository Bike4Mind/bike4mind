import { mcpServerRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { MCPClient } from '@bike4mind/mcp';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { BadRequestError } from '@server/utils/errors';
import { assertMcpServerEnabled } from '@server/utils/mcpServerFlag';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { encryptEnvVariables, decryptEnvVariables } from '@server/security/tokenEncryption';
import { mcpServerCreateBodySchema } from '@server/validators/mcpServerValidators';
import { assertNoForbiddenMcpEnvKeys } from '@server/utils/mcpEnvValidation';
import { shouldLiveFetchTools, buildMcpToolCacheUpdate } from '@bike4mind/services/llm';

// Skip schema refresh if the server was updated within this TTL (avoids unnecessary Lambda calls
// on repeated Settings visits). Schemas are always refreshed after TTL expires to pick up newly
// deployed MCP tools without manual reconnection.
const SCHEMA_REFRESH_TTL_MS = 5 * 60 * 1000;

const handler = baseApi()
  .get(async (req, res) => {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const enableMCPServer = getSettingsValue('EnableMCPServer', settings);

    if (!enableMCPServer) {
      return res.json([]);
    }

    const servers = await mcpServerRepository.find({ userId: req.user.id });

    // Refresh schemas for enabled servers whose cache has expired (older than
    // SCHEMA_REFRESH_TTL_MS). A server with no cached schemas is only refetched when it was
    // never fetched, or its empty result has aged past the marker TTL - otherwise a confirmed
    // zero-tool server was refetched on every Settings visit.
    const now = Date.now();
    const serversNeedingSchemas = servers.filter(s => {
      if (!s.enabled) return false;
      const hasCachedSchemas = s.toolSchemas && s.toolSchemas.length > 0;
      if (hasCachedSchemas) {
        const age = now - new Date(s.updatedAt).getTime();
        return age > SCHEMA_REFRESH_TTL_MS;
      }
      return shouldLiveFetchTools(s, now);
    });
    if (serversNeedingSchemas.length > 0) {
      await Promise.all(
        serversNeedingSchemas.map(async server => {
          try {
            const result = await invokeMcpHandler<MCPClient['tools']>({
              envVariables: decryptEnvVariables(server.envVariables),
              name: server.name,
              action: 'getTools',
              userId: req.user.id,
            });
            const tools = Array.isArray(result) ? result : [result].flat();
            const fetchedAt = new Date();
            await mcpServerRepository.update(buildMcpToolCacheUpdate(server.id, tools, fetchedAt));
            // Update in-memory for the response
            server.tools = tools.map((tool: { name: string }) => tool.name);
            server.toolSchemas = tools;
            server.toolSchemasFetchedAt = fetchedAt;
          } catch (error) {
            console.warn(`[MCP] Failed to populate toolSchemas for ${server.name}:`, error);
          }
        })
      );
    }

    res.json(servers);
  })
  .post(async (req, res) => {
    await assertMcpServerEnabled();
    // Guarded before the findOne below, not just before the write: `name` is part of that
    // filter, and a filter casts too -- an object or array there throws a `CastError` on the
    // route's very first statement.
    const parsedBody = mcpServerCreateBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new BadRequestError('Invalid request body');
    }
    const { name, envVariables, enabled } = parsedBody.data;
    assertNoForbiddenMcpEnvKeys(envVariables);

    let server = await mcpServerRepository.findOne({ name, userId: req.user.id });

    const encryptedVars = encryptEnvVariables(envVariables);
    if (server) {
      // New credentials mean the cached "confirmed empty" marker is no longer trustworthy.
      // Clear it before the fetch below so a failed reconnect retries instead of staying empty.
      server = await mcpServerRepository.update(
        {
          id: server.id,
          envVariables: encryptedVars,
          enabled,
        },
        { unset: ['toolSchemasFetchedAt'] }
      );
    } else {
      // `enabled` is optional in the request but `required: true` in the schema, and the two
      // branches differ on what that means: the update above drops `enabled: undefined` from the
      // `$set` and leaves the stored value alone, while a create has to supply one. Defaulting to
      // true here matches what the create used to persist -- an omitted `enabled` reached
      // mongoose as `undefined`, so a request that omitted it failed validation with a 500 rather
      // than creating a disabled server. Nothing was relying on that.
      server = await mcpServerRepository.create({
        userId: req.user.id,
        name,
        envVariables: encryptedVars,
        enabled: enabled ?? true,
        tools: [],
      });
    }
    if (server) {
      try {
        const result = await invokeMcpHandler<MCPClient['tools']>({
          envVariables,
          name: server.name,
          action: 'getTools',
          userId: req.user.id,
        });
        const tools = Array.isArray(result) ? result : [result].flat();
        server = await mcpServerRepository.update(buildMcpToolCacheUpdate(server.id, tools));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to connect to MCP server.';
        throw new BadRequestError('Unable to connect to MCP server', { reason: message });
      }
    }

    res.json(server);
  });

export default handler;
