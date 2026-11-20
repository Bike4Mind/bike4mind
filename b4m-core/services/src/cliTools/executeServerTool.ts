import { GetEffectiveApiKeyAdapters } from '../apiKeyService';
import { ToolExecutionRequest, ToolExecutionResult, ToolErrorType, type ServerToolExecutors } from './types';
import { fetchWeatherData, WeatherParams } from '../llm/tools/implementation/weather';
import { getQuestErrorCode } from '@bike4mind/common';

/**
 * Categorize errors for analytics without changing user-facing behavior
 */
function categorizeError(error: any): ToolErrorType {
  const errorMessage = error?.message?.toLowerCase() || '';

  if (errorMessage.includes('invalid input') || errorMessage.includes('must be')) {
    return ToolErrorType.INVALID_INPUT;
  }

  if (errorMessage.includes('api key') || errorMessage.includes('unauthorized') || errorMessage.includes('forbidden')) {
    return ToolErrorType.API_KEY_MISSING;
  }

  if (
    errorMessage.includes('rate limit') ||
    errorMessage.includes('too many requests') ||
    error?.response?.status === 429
  ) {
    return ToolErrorType.RATE_LIMIT;
  }

  if (
    errorMessage.includes('network') ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('econnrefused') ||
    errorMessage.includes('econnreset')
  ) {
    return ToolErrorType.NETWORK_ERROR;
  }

  if (error?.response?.status >= 400 && error?.response?.status < 600) {
    return ToolErrorType.EXTERNAL_API_ERROR;
  }

  return ToolErrorType.UNKNOWN;
}

/**
 * Execute a tool server-side using B4M's company API keys.
 * Routes to the appropriate tool executor and captures timing and errors.
 *
 * Audit logging is handled by the caller (Lambda handler) to avoid coupling
 * to specific database models.
 *
 * @param request - Tool execution request (toolName, input, userId)
 * @param adapters - Database adapters
 * @returns Tool execution result with content or error
 */
export async function executeServerTool(
  request: ToolExecutionRequest,
  adapters: GetEffectiveApiKeyAdapters,
  // Host-supplied implementations for tools this package cannot reach (see ServerToolExecutors).
  executors: ServerToolExecutors = {}
): Promise<ToolExecutionResult> {
  const startTime = Date.now();

  try {
    let content: any;
    const input: unknown = request.input;

    switch (request.toolName) {
      case 'weather_info': {
        content = await fetchWeatherData(adapters.db, input as WeatherParams);
        break;
      }

      // Paid provider calls: the host's executor holds credits around them, so a missing one fails
      // the tool rather than running it un-billed (same rule as decide).
      case 'web_search': {
        const webSearch = executors.web_search;
        if (!webSearch) throw new Error('web_search is not configured on this deployment');
        content = await webSearch(request);
        break;
      }

      case 'web_fetch': {
        const webFetch = executors.web_fetch;
        if (!webFetch) throw new Error('web_fetch is not configured on this deployment');
        content = await webFetch(request);
        break;
      }

      case 'decide': {
        const decide = executors.decide;
        if (!decide) throw new Error('decide is not configured on this deployment');
        content = await decide(request);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${request.toolName}`);
    }

    const executionTimeMs = Date.now() - startTime;

    return {
      success: true,
      content,
      executionTimeMs,
    };
  } catch (error: any) {
    const executionTimeMs = Date.now() - startTime;
    const errorMessage = error?.message || 'Unknown error occurred';
    const errorType = categorizeError(error);

    return {
      success: false,
      error: errorMessage,
      errorType,
      errorCode: getQuestErrorCode(error),
      executionTimeMs,
    };
  }
}
