import { Logger } from '@bike4mind/observability';
import { ToolDefinition, ToolContext } from '../../base/types';
import { GetEffectiveApiKeyAdapters } from '../../../../apiKeyService';
import { CitableSource, signImageUrl } from '@bike4mind/common';
import { resolveWebSearchProvider, type WebSearchImageResult, type WebSearchProviderResult } from './providers';
import { WEB_SEARCH_CARDS_PROMPT } from '../../../prompts';

/** Config `generateTools()` threads in for this tool alone - see toolGenerators.ts's `config` arg. */
export interface WebSearchToolConfig {
  /**
   * Signs every image URL shown to the model so `/api/search-image` can verify one came from an
   * actual search result before fetching it server-side, rather than trusting the model's copy of
   * it unconditionally. Reuses SECRET_ENCRYPTION_KEY (see ChatCompletionFeatures.telemetryHmacSecret
   * for the same pattern) - no dedicated secret needed. A caller that leaves this unset gets images
   * that fail verification and render as "Image unavailable" rather than an insecure fallback.
   */
  imageUrlSigningSecret?: string;
}

// serpApiSearch lives in providers.ts (alongside the provider abstraction) but is re-exported here
// so its external import path (`.../websearch`) and the existing tests stay stable.
export { serpApiSearch, resolveWebSearchProvider, recencyBucket } from './providers';
export type { WebSearchProvider, WebSearchProviderResult, WebSearchImageResult, WebSearchOptions } from './providers';

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
  /**
   * Opt in to image URLs in the tool output so the model can illustrate a visual answer with a
   * `b4m_cards` fence. Off by default: on a non-visual query the URLs are pure junk tokens, and the
   * output is byte-for-byte what it was before this parameter existed.
   */
  include_images?: boolean;
}

// One stray thumbnail among text hits is not a picture answer, so images reach the model only once
// the provider returned a real cluster of them.
const MIN_IMAGE_RESULTS = 2;

/**
 * Whether this result set is worth showing the model as images: the model asked, and the provider
 * actually returned enough pictures to build a card row from. Counts the dedicated image search too,
 * which is where nearly all of them come from - a plain web search often carries none at all.
 */
export function shouldIncludeImages(
  results: WebSearchProviderResult[],
  includeImages?: boolean,
  imageResults: WebSearchImageResult[] = []
): boolean {
  if (!includeImages) return false;
  return results.filter(r => !!r.thumbnail).length + imageResults.length >= MIN_IMAGE_RESULTS;
}

/** The image pool, rendered for the model as one line per picture. `imageUrlSigningSecret` signs
 *  each URL so the proxy can verify it later - see WebSearchToolConfig. */
export function formatImageResults(images: WebSearchImageResult[], imageUrlSigningSecret = ''): string {
  return [
    'Images found for this search (use these to build cards; each is already attributed to its own page):',
    '',
    ...images.map(
      (image, index) =>
        `${index + 1}. ${image.title || image.source}\n` +
        `   image: ${signImageUrl(image.url, imageUrlSigningSecret)}\n` +
        `   source: ${image.source}\n` +
        `   page: ${image.pageUrl}`
    ),
  ].join('\n');
}

interface WebSearchResult {
  formattedResults: string;
  citables: CitableSource[];
}

export const WEB_SEARCH_NOT_CONFIGURED_MSG =
  'Web search is not configured: an administrator needs to set a Serper API key or a local SearXNG URL ' +
  'in Admin > API Keys. No search was performed.';

export async function performWebSearch(
  adapters: GetEffectiveApiKeyAdapters,
  params: WebSearchParams,
  imageUrlSigningSecret = ''
): Promise<WebSearchResult> {
  Logger.globalInstance.log('🔍 WebSearch Tool: Starting search for query:', params.query);

  // Surface a clear "not configured" message instead of silently returning
  // "No results found", which reads to the model (and user) as if the web
  // genuinely had nothing - the exact confusion this tool's gating fixes.
  const provider = await resolveWebSearchProvider(adapters);
  if (!provider) {
    Logger.globalInstance.error('❌ WebSearch Tool: No web-search provider configured. Skipping search.');
    return { formattedResults: WEB_SEARCH_NOT_CONFIGURED_MSG, citables: [] };
  }

  try {
    const results = await provider.search(params.query, params.num_results);
    Logger.globalInstance.log(`📊 WebSearch Tool: ${provider.name} found ${results.length} results`);

    // Only on a visual query: this is a second paid provider call, so it stays behind the model's
    // own `include_images` flag and never runs on an ordinary search.
    const imageResults = params.include_images ? ((await provider.searchImages?.(params.query)) ?? []) : [];
    if (imageResults.length) {
      Logger.globalInstance.log(`🖼️ WebSearch Tool: ${provider.name} found ${imageResults.length} images`);
    }

    const withImages = shouldIncludeImages(results, params.include_images, imageResults);

    const citables: CitableSource[] = results.map((result, index) => ({
      id: result.url, // Use URL as unique identifier
      type: 'web_url' as const,
      title: result.title,
      url: result.url,
      description: result.snippet,
      timestamp: new Date().toISOString(),
      status: 'complete' as const,
      metadata: {
        sourceSystem: 'web_search',
        relevanceScore: 1 - index * 0.1, // Higher relevance for earlier results
        fullContext: result.snippet,
        ...(result.thumbnail ? { thumbnail: result.thumbnail, images: result.images } : {}),
      },
    }));

    const formattedResults = results
      .map((result, index) => {
        const imageLine =
          withImages && result.images?.length
            ? `Images: ${result.images.map(url => signImageUrl(url, imageUrlSigningSecret)).join(' | ')}\n`
            : '';
        return (
          `${index + 1}. **${result.title}**\n${result.snippet}\n` +
          imageLine +
          `Source: [${safeHostname(result.url)}](${result.url})\n`
        );
      })
      .join('\n');

    const imageSection =
      withImages && imageResults.length ? `\n${formatImageResults(imageResults, imageUrlSigningSecret)}\n` : '';

    const formattedOutput = formattedResults
      ? `Here's what I found from searching the web:\n\n${formattedResults}` +
        imageSection +
        (withImages ? `\n${WEB_SEARCH_CARDS_PROMPT}` : '')
      : 'No results found from web search.';

    return { formattedResults: formattedOutput, citables };
  } catch (error) {
    Logger.globalInstance.error('❌ WebSearch Tool: Error during search:', error);
    throw error;
  }
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  implementation: (context: ToolContext, toolConfig?: WebSearchToolConfig) => ({
    toolFn: async value => {
      const params = value as WebSearchParams;
      await context.onStart?.('web_search', params);
      const { formattedResults, citables } = await performWebSearch(
        { db: context.db },
        params,
        toolConfig?.imageUrlSigningSecret
      );

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
          include_images: {
            type: 'boolean',
            description:
              'Set true whenever the answer is about things worth SEEING - products, watches, gear, places, buildings, plants, animals, people, cars, art, food, anything with a look. Decide this yourself from the subject matter: the user will NOT ask for pictures, and an answer that describes a physical object without showing it is a worse answer. Adds a set of attributed images so you can illustrate your reply with a b4m_cards block. Leave unset only for genuinely non-visual questions - code, math, definitions, policy - where images would be junk tokens.',
          },
        },
        required: ['query'],
      },
    },
  }),
};
