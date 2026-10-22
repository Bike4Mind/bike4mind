import { ApiClient } from '../auth/ApiClient';
import { ServerToolExecutor } from './ServerToolExecutor';
import { WebSocketToolExecutor } from '../ws/WebSocketToolExecutor';
import { logger } from '../utils/Logger';

/** Optional WebSocket executor for server-side tools (bypasses CloudFront timeout) */
let wsToolExecutor: WebSocketToolExecutor | null = null;

/** Set the WebSocket tool executor for server-side tool routing */
export function setWebSocketToolExecutor(executor: WebSocketToolExecutor | null): void {
  wsToolExecutor = executor;
}

/**
 * Tool categories for routing decisions
 */
const SERVER_TOOLS = ['weather_info', 'web_search', 'web_fetch', 'decide'] as const;

type ServerToolName = (typeof SERVER_TOOLS)[number];

/**
 * Server-side tools (weather, web_search, web_fetch, decide) run on B4M's API with company keys;
 * every other tool runs locally through the implementation its caller passes in.
 */
export function isServerTool(toolName: string): toolName is ServerToolName {
  return SERVER_TOOLS.includes(toolName as ServerToolName);
}

/**
 * Execute a tool, routing to server or local execution as appropriate. Returns the raw result:
 * the tool gateway's output stage (tools/gateway/stages/output.ts) redacts and caps it, and is
 * the only caller.
 *
 * @param localToolFn - Function to execute a non-server tool locally
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  apiClient: ApiClient,
  localToolFn?: (args: Record<string, unknown>) => Promise<unknown>
): Promise<string> {
  if (isServerTool(toolName)) {
    // Prefer WebSocket when available (bypasses CloudFront 20s timeout)
    if (wsToolExecutor) {
      logger.debug(`[ToolRouter] Routing ${toolName} to server via WebSocket`);
      const result = await wsToolExecutor.execute(toolName, input);
      if (!result.success) {
        return `Error executing ${toolName}: ${result.error || 'Tool execution failed'}`;
      }
      return typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
    }

    // Fallback to HTTP
    logger.debug(`[ToolRouter] Routing ${toolName} to server via HTTP`);
    const executor = new ServerToolExecutor(apiClient);
    return await executor.executeTool(toolName, input);
  }
  // Anything else runs locally. No name list here: MCP, skill, plugin and other tools are named
  // at runtime, and a fixed list made every one of them fail as "Unknown tool".
  if (!localToolFn) throw new Error(`Unknown tool: ${toolName}`);
  logger.debug(`[ToolRouter] Executing ${toolName} locally`);
  const result = await localToolFn(input);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/**
 * Get list of server-side tools for tool schema generation
 */
export function getServerTools(): readonly ServerToolName[] {
  return SERVER_TOOLS;
}
