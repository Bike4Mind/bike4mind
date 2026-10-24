import { requiresMcpConnectionToolApproval, type IMcpServerDocument } from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import {
  generateMcpToolsFromCache,
  shouldLiveFetchTools,
  buildMcpToolCacheUpdate,
  customMcpToolId,
  generateCustomMcpTools,
  loadCustomMcpConnections,
  type CustomMcpToolHost,
  type McpToolSchema,
} from '@bike4mind/services/llm';

export interface LoadAgentMcpToolsDeps {
  mcpServers: {
    find(query: { enabled: boolean; userId: string }): Promise<IMcpServerDocument[]>;
    update(doc: {
      id: string;
      tools: string[];
      toolSchemas: McpToolSchema[];
      toolSchemasFetchedAt: Date;
    }): Promise<unknown>;
  };
  getMcpClient: (server: IMcpServerDocument) => Promise<{
    getTools: () => Promise<Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>>;
    callTool: (toolName: string, toolArgs: unknown) => Promise<unknown>;
  }>;
  /** Custom connectors; omitted -> none offered. */
  customMcp?: CustomMcpToolHost;
  logger: Logger;
}

export interface AgentMcpTools {
  mcpToolsByServer: Record<string, Array<{ name: string } & ICompletionOptionTools>>;
  serverAgentConfig: { selectedRepositories?: string; githubUsername?: string };
  /** Custom tools allowed to run without a prompt; the executor seeds them into `approvedTools`. */
  autoApprovedCustomToolNames: string[];
  /** These tools must ignore remembered approvals (org policy or an explicit always-ask choice). */
  approvalRequiredCustomToolNames: string[];
}

/**
 * Adds current automatic approvals and removes remembered choices overridden by policy.
 * Used by both the top-level execution and dispatched children.
 */
export function withAutoApprovedCustomTools(
  approvedTools: readonly string[] | undefined,
  autoApprovedCustomToolNames: readonly string[],
  approvalRequiredCustomToolNames: readonly string[] = []
): string[] {
  const requiresApproval = new Set(approvalRequiredCustomToolNames);
  return [...new Set([...(approvedTools ?? []), ...autoApprovedCustomToolNames])].filter(
    name => !requiresApproval.has(name)
  );
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
  const autoApprovedCustomToolNames: string[] = [];
  const approvalRequiredCustomToolNames: string[] = [];

  if (!opts.enableMCPServer) {
    logger.info('[AgentExecutor][MCP] EnableMCPServer is off - 0 MCP tools loaded');
    return { mcpToolsByServer, serverAgentConfig: {}, autoApprovedCustomToolNames, approvalRequiredCustomToolNames };
  }

  const servers = await deps.mcpServers.find({ enabled: true, userId: opts.userId });

  for (const server of servers) {
    try {
      let schemas = server.toolSchemas;

      // Live-fetch when cached schemas are missing (e.g. OAuth callback tool
      // fetch failed on a Lambda cold start). Mirrors the fallback in
      // ToolBuilder.buildMcpTools so agents get the same recovery path. A marker
      // younger than the TTL means the empty result is confirmed - skip the fetch.
      if (!schemas?.length && shouldLiveFetchTools(server)) {
        try {
          logger.info(`[AgentExecutor][MCP] No cached tool schemas for ${server.name} - fetching live`);
          const client = await deps.getMcpClient(server);
          const liveTools = await client.getTools();
          if (Array.isArray(liveTools)) {
            schemas = liveTools;
            // Written for an empty result too: that is the confirmed-zero-tools state.
            await deps.mcpServers.update(buildMcpToolCacheUpdate(server.id, liveTools));
            logger.info(
              `[AgentExecutor][MCP] Live-fetched and cached ${liveTools.length} tool schemas for ${server.name}`
            );
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

  // Own try/catch: a custom-connector failure drops custom tools only. There is no approval hook
  // here - the executor's permission gate pauses every tool that is not in `approvedTools`.
  if (deps.customMcp) {
    try {
      for (const connection of await loadCustomMcpConnections(deps.customMcp, opts.userId, logger)) {
        const tools = generateCustomMcpTools(connection, { userId: opts.userId, host: deps.customMcp });
        mcpToolsByServer[connection.slug] = tools;
        for (const tool of connection.tools) {
          const name = customMcpToolId(connection.slug, tool.name);
          if (!requiresMcpConnectionToolApproval(tool, connection.requireApprovalForAll)) {
            autoApprovedCustomToolNames.push(name);
          }
          if (connection.requireApprovalForAll || tool.approval === 'always_ask') {
            approvalRequiredCustomToolNames.push(name);
          }
        }
      }
    } catch (err) {
      logger.warn('[AgentExecutor][MCP] Failed to load custom connector tools - continuing without them', {
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

  return {
    mcpToolsByServer,
    serverAgentConfig: { selectedRepositories, githubUsername },
    autoApprovedCustomToolNames,
    approvalRequiredCustomToolNames,
  };
}
