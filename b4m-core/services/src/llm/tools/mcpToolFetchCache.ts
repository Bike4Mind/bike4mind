/**
 * Cache policy for live MCP tool fetches, shared by both guard paths so they cannot drift:
 * the chat path (ToolBuilder.buildMcpTools) and the agent path (loadAgentMcpTools).
 *
 * An empty `toolSchemas` is ambiguous - never fetched, or fetched and genuinely zero tools.
 * `toolSchemasFetchedAt` breaks the tie. It is written only after a successful `getTools()`
 * (empty or not), so a failed fetch leaves it unset and retries next turn; it also expires,
 * so a server that later gains tools is picked up without a manual reconnect.
 *
 * Leaf module - no tool-implementation imports (see toolGenerators.ts's header).
 */

/** How long a confirmed-empty fetch is trusted before it is retried. */
export const MCP_EMPTY_TOOL_FETCH_TTL_MS = 60 * 60 * 1000; // 1h

export interface McpToolSchema {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

/**
 * Whether a server with no cached schemas should be live-fetched now. Only consulted for the
 * empty-cache case; a non-empty cache is served as-is (the GET route has its own refresh TTL).
 */
export function shouldLiveFetchTools(
  server: { toolSchemasFetchedAt?: Date | null },
  now: number = Date.now()
): boolean {
  const fetchedAt = server.toolSchemasFetchedAt;
  if (!fetchedAt) return true;
  return now - new Date(fetchedAt).getTime() >= MCP_EMPTY_TOOL_FETCH_TTL_MS;
}

/**
 * The fields a successful fetch persists. Shared so every writer stamps `toolSchemasFetchedAt`
 * in the same shape - omitting it here would silently reintroduce the per-turn refetch.
 */
export function buildMcpToolCacheUpdate(
  serverId: string,
  tools: McpToolSchema[],
  fetchedAt: Date = new Date()
): { id: string; tools: string[]; toolSchemas: McpToolSchema[]; toolSchemasFetchedAt: Date } {
  return {
    id: serverId,
    tools: tools.map(tool => tool.name),
    toolSchemas: tools,
    toolSchemasFetchedAt: fetchedAt,
  };
}
