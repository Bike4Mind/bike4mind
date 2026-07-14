import type { IMcpServerDocument } from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { generateMcpToolsFromCache } from '@bike4mind/services';

export interface LoadAgentMcpToolsDeps {
  mcpServers: { find(query: { enabled: boolean; userId: string }): Promise<IMcpServerDocument[]> };
  getMcpClient: (
    server: IMcpServerDocument
  ) => Promise<{ callTool: (toolName: string, toolArgs: unknown) => Promise<unknown> }>;
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
    if (!server.toolSchemas?.length) {
      logger.warn(`[AgentExecutor][MCP] No tool schemas for ${server.name} - skipping (reconnect to populate)`);
      continue;
    }
    try {
      const callTool = async (toolName: string, toolArgs: unknown) => {
        const client = await deps.getMcpClient(server);
        return client.callTool(toolName, toolArgs);
      };
      mcpToolsByServer[server.name] = generateMcpToolsFromCache(server.name, server.toolSchemas, callTool);
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
