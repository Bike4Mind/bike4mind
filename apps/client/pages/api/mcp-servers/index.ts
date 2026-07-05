import { mcpServerRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { MCPClient } from '@bike4mind/mcp';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { BadRequestError } from '@server/utils/errors';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { encryptEnvVariables, decryptEnvVariables } from '@server/security/tokenEncryption';

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

    // Refresh schemas for enabled servers that either have no cached schemas or
    // whose cache has expired (older than SCHEMA_REFRESH_TTL_MS).
    const now = Date.now();
    const serversNeedingSchemas = servers.filter(s => {
      if (!s.enabled) return false;
      const hasCachedSchemas = s.toolSchemas && s.toolSchemas.length > 0;
      if (!hasCachedSchemas) return true;
      const age = now - new Date(s.updatedAt).getTime();
      return age > SCHEMA_REFRESH_TTL_MS;
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
            await mcpServerRepository.update({
              id: server.id,
              tools: tools.map((tool: { name: string }) => tool.name),
              toolSchemas: tools,
            });
            // Update in-memory for the response
            server.tools = tools.map((tool: { name: string }) => tool.name);
            server.toolSchemas = tools;
          } catch (error) {
            console.warn(`[MCP] Failed to populate toolSchemas for ${server.name}:`, error);
          }
        })
      );
    }

    res.json(servers);
  })
  .post(async (req, res) => {
    const { name, envVariables, enabled } = req.body;

    let server = await mcpServerRepository.findOne({ name, userId: req.user.id });

    const encryptedVars = encryptEnvVariables(envVariables);
    if (server) {
      server = await mcpServerRepository.update({
        id: server.id,
        envVariables: encryptedVars,
        enabled,
      });
    } else {
      server = await mcpServerRepository.create({
        userId: req.user.id,
        name,
        envVariables: encryptedVars,
        enabled,
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
        server = await mcpServerRepository.update({
          id: server.id,
          tools: tools.map(tool => tool.name),
          toolSchemas: tools,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to connect to MCP server.';
        throw new BadRequestError('Unable to connect to MCP server', { reason: message });
      }
    }

    res.json(server);
  });

export default handler;
