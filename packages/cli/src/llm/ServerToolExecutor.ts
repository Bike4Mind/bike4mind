import { ApiClient } from '../auth/ApiClient';
import { logger } from '../utils/Logger';

/**
 * Tool execution result from server
 */
interface ToolExecutionResult {
  success: boolean;
  content?: string;
  error?: string;
  executionTimeMs?: number;
}

/**
 * Executes tools server-side using B4M's company API keys
 *
 * This class handles server-side tool execution for tools like weather and web search.
 * The API keys are never exposed to the CLI - they remain secure on the server.
 *
 * Supported tools:
 * - weather_info: Get current weather from OpenWeather API
 * - web_search: Search the web using SerpAPI
 */
export class ServerToolExecutor {
  private apiClient: ApiClient;
  private readonly toolsEndpoint = '/api/ai/v1/tools';

  constructor(apiClient: ApiClient) {
    this.apiClient = apiClient;
  }

  /**
   * Execute a tool server-side
   *
   * @param toolName - Name of the tool to execute (e.g., 'weather_info', 'web_search')
   * @param input - Tool input parameters
   * @returns Tool execution result (content or error)
   */
  async executeTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    logger.debug(`[ServerToolExecutor] Executing tool: ${toolName}`);
    logger.debug(`[ServerToolExecutor] Endpoint: ${this.toolsEndpoint}`);
    logger.debug(`[ServerToolExecutor] Input: ${JSON.stringify(input)}`);

    try {
      // ApiClient.post() returns the data directly, not wrapped in { data: ... }
      const result = await this.apiClient.post<ToolExecutionResult>(this.toolsEndpoint, {
        toolName,
        input,
      });

      logger.debug(`[ServerToolExecutor] Response: ${JSON.stringify(result)}`);

      if (!result.success) {
        const errorMessage = result.error || 'Tool execution failed';
        logger.error(`[ServerToolExecutor] Tool ${toolName} failed: ${errorMessage}`);
        // Return error as string (LLM can handle it gracefully)
        return `Error executing ${toolName}: ${errorMessage}`;
      }

      logger.debug(`[ServerToolExecutor] Tool ${toolName} succeeded in ${result.executionTimeMs}ms`);
      return result.content || '';
    } catch (error: unknown) {
      // Handle network or API errors
      const err = error as { response?: { data?: { error?: string }; status?: number }; message?: string };
      const errorMessage = err?.response?.data?.error || err?.message || 'Unknown error';
      const status = err?.response?.status || 'unknown';
      logger.error(`[ServerToolExecutor] Request failed for ${toolName}: ${errorMessage} (status: ${status})`);
      logger.debug(`[ServerToolExecutor] Full error: ${JSON.stringify(err, null, 2)}`);

      // Return error as string (LLM can read and explain to user)
      return `Error executing ${toolName}: ${errorMessage}`;
    }
  }
}
