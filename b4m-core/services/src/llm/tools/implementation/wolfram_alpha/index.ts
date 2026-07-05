import { ToolDefinition, ToolContext } from '../../base/types';
import { GetEffectiveApiKeyAdapters, getWolframAlphaKey } from '../../../../apiKeyService';
import { Logger } from '@bike4mind/observability';

// Maximum query length to prevent extremely long inputs
const MAX_QUERY_LENGTH = 500;
// Maximum response size to prevent memory issues (50KB, same as webfetch)
const MAX_RESPONSE_SIZE = 50000;

export interface WolframAlphaParams {
  query: string;
  maxchars?: number;
}

/**
 * Validates query parameters and returns an error message if invalid
 */
export function validateQueryParams(params: WolframAlphaParams): string | null {
  if (!params.query || typeof params.query !== 'string') {
    return 'Invalid query parameter: query must be a non-empty string.';
  }

  const trimmedQuery = params.query.trim();
  if (trimmedQuery.length === 0) {
    return 'Query cannot be empty.';
  }

  if (params.query.length > MAX_QUERY_LENGTH) {
    return `Query is too long. Maximum ${MAX_QUERY_LENGTH} characters allowed.`;
  }

  return null;
}

export async function wolframAlphaQuery(
  adapters: GetEffectiveApiKeyAdapters,
  params: WolframAlphaParams,
  logger?: Logger
): Promise<string> {
  const validationError = validateQueryParams(params);
  if (validationError) {
    logger?.error('Wolfram Alpha: Validation failed', { error: validationError });
    return validationError;
  }

  const appId = await getWolframAlphaKey(adapters);

  if (!appId) {
    logger?.error('Wolfram Alpha: No API key configured');
    return 'Wolfram Alpha is not configured. Please contact your administrator to set up the WolframAlphaKey in admin settings.';
  }

  const url = new URL('https://www.wolframalpha.com/api/v1/llm-api');
  url.searchParams.set('input', params.query.trim());
  url.searchParams.set('appid', appId);
  if (params.maxchars) {
    url.searchParams.set('maxchars', params.maxchars.toString());
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    logger?.log('🔢 Wolfram Alpha: Querying:', params.query);

    const response = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    logger?.log('📡 Wolfram Alpha: Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      logger?.error('Wolfram Alpha: API error', {
        status: response.status,
        statusText: response.statusText,
        errorText,
      });

      if (response.status === 501) {
        const suggestions = errorText ? `\n\nWolfram Alpha responded: ${errorText}` : '';
        return `Wolfram Alpha could not interpret this query. This typically happens when:
1. The query combines multiple concepts that should be broken into simpler parts
2. The query is too vague or conversational
3. The query doesn't contain a specific computation or data lookup
4. The query asks about Wolfram Alpha's capabilities (meta-queries are not supported)

Try breaking compound queries into simpler steps, or send a concrete computational query like "integrate x^2 dx", "population of Japan 2023", or "convert 100 USD to EUR".${suggestions}`;
      }
      if (response.status === 500) {
        const detail = errorText ? `\n\nWolfram Alpha responded: ${errorText}` : '';
        return `Wolfram Alpha encountered a temporary server error. This is usually a transient issue on Wolfram Alpha's side. Please try your query again in a moment.${detail}`;
      }
      if (response.status === 403) {
        return `Wolfram Alpha API key is invalid or missing. Please contact your administrator.`;
      }

      return `Wolfram Alpha error: ${response.statusText}`;
    }

    const result = await response.text();

    // Limit response size to prevent memory issues
    const maxSize = Math.min(params.maxchars || MAX_RESPONSE_SIZE, MAX_RESPONSE_SIZE);
    const truncatedResult = result.slice(0, maxSize);

    logger?.log('✅ Wolfram Alpha: Query successful, response length:', truncatedResult.length);

    return truncatedResult || 'No results from Wolfram Alpha.';
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      logger?.error('Wolfram Alpha: Request timed out');
      return 'Wolfram Alpha request timed out. Please try a simpler query.';
    }

    logger?.error('Wolfram Alpha: Fetch error', error);
    return 'Failed to reach Wolfram Alpha. Please try again.';
  }
}

export const wolframAlphaTool: ToolDefinition = {
  name: 'wolfram_alpha',
  implementation: (context: ToolContext) => ({
    toolFn: async value => {
      const params = value as WolframAlphaParams;
      await context.onStart?.('wolfram_alpha', params);
      const result = await wolframAlphaQuery({ db: context.db }, params, context.logger);
      return result;
    },
    toolSchema: {
      name: 'wolfram_alpha',
      description: `Query Wolfram Alpha for computational knowledge.

USE FOR:
- Mathematical calculations (algebra, calculus, statistics, symbolic math)
- Unit conversions and physical constants
- Scientific queries (physics, chemistry, astronomy, biology)
- Data lookups (populations, distances, historical data, financial data)
- Equation solving and plotting
- Date/time calculations and conversions

DO NOT USE FOR:
- General knowledge questions or programming help
- Simple arithmetic you can compute yourself (e.g., 2+2, 10*5)
- Questions ABOUT Wolfram Alpha itself (e.g., "What can Wolfram Alpha do?", "List Wolfram Alpha's capabilities")
- Meta-queries asking the tool to describe its features or domains

IMPORTANT: Always send a specific computational query (e.g., "integrate x^2 from 0 to 1", "convert 100 miles to km"). Never ask the tool to describe what it can do.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Natural language query or mathematical expression. Use simplified keywords. For exponents, use notation like 6*10^14 (not 6e14).',
          },
          maxchars: {
            type: 'number',
            description: 'Maximum characters in response (default: 6800)',
          },
        },
        required: ['query'],
      },
    },
  }),
};
