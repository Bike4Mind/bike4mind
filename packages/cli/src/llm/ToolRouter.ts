import { ApiClient } from '../auth/ApiClient';
import { ServerToolExecutor } from './ServerToolExecutor';
import { WebSocketToolExecutor } from '../ws/WebSocketToolExecutor';
import { logger } from '../utils/Logger';

/** Optional WebSocket executor for server-side tools (bypasses CloudFront timeout) */
let wsToolExecutor: WebSocketToolExecutor | null = null;

/** Dynamically registered tool names from feature modules (treated as local tools) */
const featureModuleTools = new Set<string>();

/** Register tool names from feature modules so the router treats them as local tools */
export function registerFeatureModuleTools(toolNames: string[]): void {
  for (const name of toolNames) {
    featureModuleTools.add(name);
  }
}

/** Clear all registered feature module tools (used during hot-reload) */
export function clearFeatureModuleTools(): void {
  featureModuleTools.clear();
}

function isFeatureModuleTool(toolName: string): boolean {
  return featureModuleTools.has(toolName);
}

/** Set the WebSocket tool executor for server-side tool routing */
export function setWebSocketToolExecutor(executor: WebSocketToolExecutor | null): void {
  wsToolExecutor = executor;
}

/**
 * Tool categories for routing decisions
 */
const SERVER_TOOLS = ['weather_info', 'web_search', 'web_fetch'] as const;
const LOCAL_TOOLS = [
  'file_read',
  'create_file',
  'edit_local_file',
  'glob_files',
  'grep_search',
  'delete_file',
  'dice_roll',
  'math_evaluate',
  'current_datetime',
  'bash_execute',
  'check_shell_output',
  'write_shell_stdin',
  'list_background_shells',
  'kill_background_shell',
  'recent_changes',
  'ask_user_question',
] as const;

type ServerToolName = (typeof SERVER_TOOLS)[number];
type LocalToolName = (typeof LOCAL_TOOLS)[number];

/**
 * Determines whether a tool should execute server-side or locally
 *
 * Server-side tools (weather, web_search):
 * - Use B4M's company API keys
 * - Execute via Lambda
 * - No local API key configuration needed
 *
 * Local tools (file operations):
 * - Execute in CLI process
 * - Require local file system access
 * - Fast, no network latency
 */
export function isServerTool(toolName: string): toolName is ServerToolName {
  return SERVER_TOOLS.includes(toolName as ServerToolName);
}

export function isLocalTool(toolName: string): toolName is LocalToolName {
  return LOCAL_TOOLS.includes(toolName as LocalToolName);
}

/**
 * Execute a tool, routing to server or local execution as appropriate
 *
 * @param toolName - Name of the tool to execute
 * @param input - Tool input parameters
 * @param apiClient - API client for server-side execution
 * @param localToolFn - Function to execute tool locally (optional)
 * @returns Tool execution result as string
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
  } else if (isLocalTool(toolName) || isFeatureModuleTool(toolName)) {
    // Execute locally
    logger.debug(`[ToolRouter] Executing ${toolName} locally`);
    if (!localToolFn) {
      throw new Error(`Local tool ${toolName} has no implementation`);
    }
    const result = await localToolFn(input);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } else {
    throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Get list of server-side tools for tool schema generation
 */
export function getServerTools(): readonly ServerToolName[] {
  return SERVER_TOOLS;
}

/**
 * Get list of local tools for tool schema generation
 */
export function getLocalTools(): readonly LocalToolName[] {
  return LOCAL_TOOLS;
}
