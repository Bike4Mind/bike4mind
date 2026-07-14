import { GetEffectiveApiKeyAdapters } from '../apiKeyService';
import { ToolExecutionRequest, ToolExecutionResult, ToolErrorType } from './types';
import { firecrawlFetch, webFetchBody } from '../llm/tools/implementation/webfetch';
import { performWebSearch, WebSearchParams } from '../llm/tools/implementation/websearch';
import { fetchWeatherData, WeatherParams } from '../llm/tools/implementation/weather';

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
  adapters: GetEffectiveApiKeyAdapters
): Promise<ToolExecutionResult> {
  const startTime = Date.now();

  try {
    let content: any;

    switch (request.toolName) {
      case 'weather_info': {
        content = await fetchWeatherData(adapters.db, request.input as WeatherParams);
        break;
      }

      case 'web_search': {
        const result = await performWebSearch({ db: adapters.db }, request.input as WebSearchParams);
        content = result.formattedResults;
        break;
      }

      case 'web_fetch': {
        const result = await firecrawlFetch({ db: adapters.db }, request.input.url, {
          offset: request.input.offset,
        });
        // Shared formatter keeps truncation/continuation in-band and consistent with the
        // web_fetch tool and HTTP endpoint.
        content = webFetchBody(result);
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
      executionTimeMs,
    };
  }
}
