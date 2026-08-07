import type { IMcpServerDocument } from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { generateMcpToolsFromCache } from '@bike4mind/services';

export interface LoadAgentMcpToolsDeps {
  mcpServers: {
    find(query: { enabled: boolean; userId: string }): Promise<IMcpServerDocument[]>;
    update?(doc: { id: string; tools: string[]; toolSchemas: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }> }): Promise<unknown>;
  };
  getMcpClient: (
    server: IMcpServerDocument
  ) => Promise<{
    getTools?: () => Promise<Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>>;
    callTool: (toolName: string, toolArgs: unknown) => Promise<unknown>;
  }>;
  logger: Logger;
}

export interface AgentMcpTools {
  mcpToolsByServer: Record<string, Array<{ name: string } & ICompletionOptionTools>>;
  serverAgentConfig: { selectedRepositories?: string; githubUsername?: string };
}

/**
 * Load MCP tool definitions for Agent Mode (agent_executor) from DB-cached
 * schemas. Mirrors ToolBuilder.buildMcpTools for the executor, which has no
 * client-supplied server list, so it always loads ALL enabled servers for the
 * user. Tool schemas are populated by GET /api/mcp-servers and the OAuth
 * flows; callTool connects lazily via Lambda only when the LLM invokes a tool.
 */
export async function loadAgentMcpTools(
  deps: LoadAgentMcpToolsDeps,
  opts: { userId: string; enableMCPServer: boolean }
): Promise<AgentMcpTools> {
  const { logger } = deps;
  const mcpToolsByServer: AgentMcpTools['mcpToolsByServer'] = {};

  if (!opts.enableMCPServer) {
    logger.info('[AgentExecutor][MCP] EnableMCPServer is off - 0 MCP tools loaded');
    return { mcpToolsByServer, serverAgentConfig: {} };
  }

  const servers = await deps.mcpServers.find({ enabled: true, userId: opts.userId });

  for (const server of servers) {
    try {
      let schemas = server.toolSchemas;

      // Live-fetch when cached schemas are missing (e.g. OAuth callback tool
      // fetch failed on a Lambda cold start). Mirrors the fallback in
      // ToolBuilder.buildMcpTools so agents get the same recovery path.
      if (!schemas?.length) {
        try {
          logger.info(`[AgentExecutor][MCP] No cached tool schemas for ${server.name} - fetching live`);
          const client = await deps.getMcpClient(server);
          if (client.getTools) {
            const liveTools = await client.getTools();
            if (Array.isArray(liveTools) && liveTools.length > 0) {
              schemas = liveTools;
              if (deps.mcpServers.update) {
                await deps.mcpServers.update({
                  id: server.id,
                  tools: liveTools.map((t: { name: string }) => t.name),
                  toolSchemas: liveTools,
                });
              }
              logger.info(`[AgentExecutor][MCP] Live-fetched and cached ${liveTools.length} tool schemas for ${server.name}`);
            }
          }
        } catch (fetchError) {
          logger.warn(`[AgentExecutor][MCP] Live tool fetch failed for ${server.name} - skipping`, {
            error: fetchError instanceof Error ? fetchError.message : String(fetchError),
          });
        }
      }

      if (!schemas?.length) {
        logger.warn(`[AgentExecutor][MCP] No tool schemas for ${server.name} - skipping (reconnect to populate)`);
        continue;
      }

      const callTool = async (toolName: string, toolArgs: unknown) => {
        const client = await deps.getMcpClient(server);
        return client.callTool(toolName, toolArgs);
      };
      mcpToolsByServer[server.name] = generateMcpToolsFromCache(server.name, schemas, callTool);
    } catch (err) {
      // Isolate per server: a malformed cached schema for one server must not drop the others' tools.
      logger.warn(`[AgentExecutor][MCP] Failed to build tools for ${server.name} - skipping`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const githubServer = servers.find(s => s.name === 'github');
  let selectedRepositories: string | undefined;
  if (githubServer?.metadata?.selectedRepositories?.length) {
    selectedRepositories = githubServer.metadata.selectedRepositories.map(r => `- ${r.fullName}`).join('\n');
  }
  const githubUsername = githubServer?.metadata?.githubLogin || undefined;

  logger.info('[AgentExecutor][MCP] loaded MCP tools', {
    perServer: Object.fromEntries(Object.entries(mcpToolsByServer).map(([k, v]) => [k, v.length])),
  });

  return { mcpToolsByServer, serverAgentConfig: { selectedRepositories, githubUsername } };
}
