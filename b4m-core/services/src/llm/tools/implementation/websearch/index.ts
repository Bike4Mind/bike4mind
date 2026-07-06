import { Logger } from '@bike4mind/observability';
import { ToolDefinition, ToolContext } from '../../base/types';
import { GetEffectiveApiKeyAdapters, getSerperKey } from '../../../../apiKeyService';
import { CitableSource } from '@bike4mind/common';

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface WebSearchParams {
  query: string;
  num_results?: number;
}

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

interface WebSearchResult {
  formattedResults: string;
  citables: CitableSource[];
}

export async function serpApiSearch(
  adapters: GetEffectiveApiKeyAdapters,
  query: string,
  num_results?: number
): Promise<any> {
  const apiKey = await getSerperKey(adapters);
  const url = new URL('https://serpapi.com/search');

  if (!apiKey) {
    Logger.globalInstance.error('❌ WebSearch Tool: No API key configured. Skipping search.');
    return { organic_results: [] };
  }
  // Add required SerpAPI parameters exactly as shown in playground
  const searchParams = new URLSearchParams({
    engine: 'google',
    api_key: apiKey,
    q: query,
    location: 'United States',
    google_domain: 'google.com',
    gl: 'us',
    hl: 'en',
    num: (num_results || 3).toString(),
  });

  url.search = searchParams.toString();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  Logger.globalInstance.log('📡 WebSearch Tool: Response status:', response.status);

  if (!response.ok) {
    const errorText = await response.text();
    Logger.globalInstance.error('❌ WebSearch Tool: API error details:', {
      status: response.status,
      statusText: response.statusText,
      errorText,
      endpoint: url.origin,
    });
    throw new Error(`SERP API error: ${response.statusText} - ${errorText}`);
  }

  return response.json();
}

export const WEB_SEARCH_NOT_CONFIGURED_MSG =
  'Web search is not configured: an administrator needs to set the Serper API key in Admin > API Keys. ' +
  'No search was performed.';

export async function performWebSearch(
  adapters: GetEffectiveApiKeyAdapters,
  params: WebSearchParams
): Promise<WebSearchResult> {
  Logger.globalInstance.log('🔍 WebSearch Tool: Starting search for query:', params.query);

  // Surface a clear "not configured" message instead of silently returning
  // "No results found", which reads to the model (and user) as if the web
  // genuinely had nothing - the exact confusion this tool's gating fixes.
  const apiKey = await getSerperKey(adapters);
  if (!apiKey) {
    Logger.globalInstance.error('❌ WebSearch Tool: No API key configured. Skipping search.');
    return { formattedResults: WEB_SEARCH_NOT_CONFIGURED_MSG, citables: [] };
  }

  try {
    const data = await serpApiSearch(adapters, params.query, params.num_results);
    Logger.globalInstance.log('📡 WebSearch Tool: Response status:', data.status);
    Logger.globalInstance.log('📊 WebSearch Tool: Found results:', data.organic_results?.length || 0);
    const results: SearchResult[] =
      data.organic_results?.map((result: any) => ({
        title: result.title,
        link: result.link,
        snippet: result.snippet,
      })) || [];

    const citables: CitableSource[] = results.map((result, index) => ({
      id: result.link, // Use URL as unique identifier
      type: 'web_url' as const,
      title: result.title,
      url: result.link,
      description: result.snippet,
      timestamp: new Date().toISOString(),
      status: 'complete' as const,
      metadata: {
        sourceSystem: 'web_search',
        relevanceScore: 1 - index * 0.1, // Higher relevance for earlier results
        fullContext: result.snippet,
      },
    }));

    const formattedResults = results
      .map(
        (result, index) =>
          `${index + 1}. **${result.title}**\n${result.snippet}\n` +
          `Source: [${safeHostname(result.link)}](${result.link})\n`
      )
      .join('\n');

    const formattedOutput = formattedResults
      ? `Here's what I found from searching the web:\n\n${formattedResults}`
      : 'No results found from web search.';

    return { formattedResults: formattedOutput, citables };
  } catch (error) {
    Logger.globalInstance.error('❌ WebSearch Tool: Error during search:', error);
    throw error;
  }
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  implementation: (context: ToolContext) => ({
    toolFn: async value => {
      const params = value as WebSearchParams;
      await context.onStart?.('web_search', params);
      const { formattedResults, citables } = await performWebSearch({ db: context.db }, params);

      // statusUpdate Object.assigns this partial onto the quest, so citables must be nested
      // under promptMeta; the receiver is responsible for merging promptMeta.citables.
      if (citables.length > 0) {
        await context.statusUpdate(
          {
            promptMeta: {
              citables,
            },
          } as any,
          'Web search complete'
        );
        Logger.globalInstance.log(`📚 WebSearch Tool: Stored ${citables.length} citables`);
      }

      return formattedResults;
    },
    toolSchema: {
      name: 'web_search',
      description:
        'Search the web using Google Search API to FIND pages about a topic. Use this when you need to find URLs or search for information. DO NOT use this if the user provides a specific URL - use web_fetch instead to read the full content.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to look up',
          },
          num_results: {
            type: 'number',
            description: 'Number of results to return (default: 3, max: 10)',
            minimum: 1,
            maximum: 10,
          },
        },
        required: ['query'],
      },
    },
  }),
};
