import { Logger } from '@bike4mind/observability';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { ToolDefinition, ToolContext } from '../../base/types';
import { GetEffectiveApiKeyAdapters } from '../../../../apiKeyService';
import {
  CitableSource,
  googleMapsSearchUrl,
  isPlaceholderImageSigningSecret,
  signImageUrl,
  type WebSearchPlace,
} from '@bike4mind/common';
import {
  resolveWebSearchProviders,
  searchCacheGet,
  searchCacheSet,
  SERPAPI_BACKUP_ATTEMPTS,
  WEB_SEARCH_HEDGE_DELAY_MS,
  type WebSearchOptions,
  type WebSearchImageResult,
  type WebSearchProvider,
  type WebSearchProviderResult,
} from './providers';
import { WEB_SEARCH_CARDS_PROMPT, WEB_SEARCH_MAP_PROMPT } from '../../../prompts';

/** Config `generateTools()` threads in for this tool alone - see toolGenerators.ts's `config` arg. */
export interface WebSearchToolConfig {
  /**
   * Signs every image URL shown to the model so `/api/search-image` can verify one came from an
   * actual search result before fetching it server-side, rather than trusting the model's copy of
   * it unconditionally. Reuses SECRET_ENCRYPTION_KEY (see ChatCompletionFeatures.telemetryHmacSecret
   * for the same pattern) - no dedicated secret needed. A caller that leaves this unset (or an
   * empty/placeholder value) degrades to plain prose: no image search, no cards prompt, rather
   * than paying for images that would only fail verification and render as "Image unavailable".
   */
  imageUrlSigningSecret?: string;
}

// serpApiSearch lives in providers.ts (alongside the provider abstraction) but is re-exported here
// so its external import path (`.../websearch`) and the existing tests stay stable.
export {
  serpApiSearch,
  resolveWebSearchProvider,
  resolveWebSearchProviders,
  recencyBucket,
  searchCacheClear,
} from './providers';
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
  /**
   * Opt in to a place search with provider coordinates, so the model can show the places on a
   * `b4m_map` inline map. Off by default, with the same byte-for-byte guarantee as include_images.
   */
  include_places?: boolean;
  /** A reference place the user named ("my hotel, the citizenM"), located and shown distinctly. */
  anchor_location?: string;
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
  // Sum actual pictures, not hits-that-have-at-least-one-image: a provider like SearXNG can
  // return one organic hit carrying several images, which would otherwise undercount a real
  // card-worthy cluster as a single picture.
  const organicImageCount = results.reduce((sum, r) => sum + (r.images?.length ?? 0), 0);
  return organicImageCount + imageResults.length >= MIN_IMAGE_RESULTS;
}

// One pin is a point, not a map: the widget earns its space only when there is something to compare.
const MIN_PLACE_RESULTS = 2;

export function shouldIncludePlaces(places: WebSearchPlace[], includePlaces?: boolean): boolean {
  return !!includePlaces && places.length >= MIN_PLACE_RESULTS;
}

/** The image pool, rendered for the model as one line per picture. `imageUrlSigningSecret` signs
 *  each URL so the proxy can verify it later - see WebSearchToolConfig. */
// Strips raw newlines a hostile search snippet could use to forge extra fake lines in this
// line-structured tool output (each field is interpolated onto its own line below).
function stripNewlines(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

export function formatImageResults(images: WebSearchImageResult[], imageUrlSigningSecret = ''): string {
  return [
    'Images found for this search (use these to build cards; each is already attributed to its own page):',
    '',
    ...images.map((image, index) => {
      const title = stripNewlines(image.title || image.source);
      const source = stripNewlines(image.source);
      const pageUrl = stripNewlines(image.pageUrl);
      return (
        `${index + 1}. ${title}\n` +
        `   image: ${signImageUrl(image.url, imageUrlSigningSecret)}\n` +
        `   source: ${source}\n` +
        `   page: ${pageUrl}`
      );
    }),
  ].join('\n');
}

function describePlace(place: WebSearchPlace): string {
  const rating =
    place.rating !== undefined
      ? `${place.rating}${place.reviews !== undefined ? ` (${place.reviews} reviews)` : ''}`
      : undefined;
  return [place.name, rating, place.category, place.address]
    .filter((part): part is string => !!part)
    .map(stripNewlines)
    .join(' - ');
}

export function formatPlaceResults(places: WebSearchPlace[], anchor?: WebSearchPlace): string {
  return [
    'Places found for this search (each has a map location; refer to it by its id):',
    '',
    ...places.map((place, index) => `${index + 1}. ${describePlace(place)}\n   id: ${stripNewlines(place.id)}`),
    ...(anchor
      ? [
          '',
          'Anchor location (the place the user named):',
          `${describePlace(anchor)}\n   id: ${stripNewlines(anchor.id)}`,
        ]
      : []),
  ].join('\n');
}

/**
 * A place as a citable, carrying the place itself in `metadata.place` - the only thing the map
 * widget reads pins from. The thumbnail is signed for /api/search-image, or dropped when the
 * deploy cannot sign (it would only ever render as a failed tile).
 */
function placeCitable(place: WebSearchPlace, imageUrlSigningSecret: string, canSignImages: boolean): CitableSource {
  const { thumbnail, ...rest } = place;
  return {
    id: `place:${place.id}`,
    type: 'web_url',
    title: place.name,
    url: googleMapsSearchUrl(place.name, place.id),
    description: [place.category, place.address].filter(Boolean).join(' - ') || undefined,
    timestamp: new Date().toISOString(),
    status: 'complete',
    metadata: {
      sourceSystem: 'web_search',
      place: {
        ...rest,
        ...(thumbnail && canSignImages ? { thumbnail: signImageUrl(thumbnail, imageUrlSigningSecret) } : {}),
      },
    },
  };
}

interface WebSearchResult {
  formattedResults: string;
  citables: CitableSource[];
}

export const WEB_SEARCH_NOT_CONFIGURED_MSG =
  'Web search is not configured: an administrator needs to set a Serper API key or a local SearXNG URL ' +
  'in Admin > API Keys. No search was performed.';

// A multi-entity comparison fans out to one search per entity plus a refinement or two; past this
// the model is re-searching rather than answering, and each extra round costs a full model turn.
export const MAX_WEB_SEARCHES_PER_TURN = 6;

/**
 * Caps web_search calls for one model conversation. The chat turn applies it to its own tool list
 * only, after buildTools: subagents capture the unwrapped tool inside buildTools and agent runs
 * never apply it, so neither is capped. Call `reset()` whenever a retry or fallback restarts the
 * conversation - the cap message points the model at earlier results it must still be able to see.
 */
export function createWebSearchBudget(maxSearches: number) {
  let used = 0;
  return {
    reset: () => {
      used = 0;
    },
    apply: (tools: ICompletionOptionTools[]): ICompletionOptionTools[] =>
      tools.map(tool =>
        tool.toolSchema.name !== 'web_search'
          ? tool
          : {
              ...tool,
              // Counted before any await so parallel calls within one round each take their own slot.
              toolFn: async (parameters, apiKey) => {
                if (++used > maxSearches) {
                  Logger.globalInstance.log(`🔍 WebSearch Tool: call #${used} capped, instructing model to answer`);
                  return (
                    `Search limit reached: ${maxSearches} web searches have already run this turn and their ` +
                    `results are in the conversation above. Do not search again. Compose your complete answer NOW ` +
                    `from those results, and say plainly if anything could not be confirmed.`
                  );
                }
                return tool.toolFn(parameters, apiKey);
              },
            }
      ),
  };
}

class EmptySearchAnswer extends Error {}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Organic search as a hedged request: the lead starts at once, and the backup starts alongside it
 * once the lead has been silent for WEB_SEARCH_HEDGE_DELAY_MS, or as soon as the lead fails. The
 * first non-empty answer wins; the loser runs on to its own timeout and is ignored. An empty lead
 * answer also starts the backup, since a throttled SearXNG answers 200 with no results. With no
 * backup the lead keeps its own failure mode (SearXNG fail-soft, SerpAPI throws). Returns the
 * provider that answered so the image/place calls go to a live provider. When both come back empty
 * it returns the empty answer; when both fail it throws, so the backend records the call as failed.
 */
export async function searchWithHedge(
  lead: WebSearchProvider,
  backup: WebSearchProvider | null,
  query: string,
  numResults: number,
  searchOptions?: WebSearchOptions
): Promise<{ results: WebSearchProviderResult[]; servedBy: WebSearchProvider }> {
  if (!backup) return { results: await lead.search(query, numResults, searchOptions), servedBy: lead };

  const fromLead = lead.search(query, numResults, { ...searchOptions, throwOnError: true });
  const backupStart = new Promise<'slow' | 'failed' | 'empty'>(start => {
    const timer = setTimeout(() => start('slow'), WEB_SEARCH_HEDGE_DELAY_MS);
    fromLead.then(
      results => {
        clearTimeout(timer);
        if (results.length === 0) start('empty');
      },
      () => {
        clearTimeout(timer);
        start('failed');
      }
    );
  });
  const fromBackup = backupStart.then(reason => {
    Logger.globalInstance.log('WebSearch Tool: starting backup provider', {
      lead: lead.name,
      backup: backup.name,
      reason,
    });
    // maxAttempts only bounds SerpAPI; SearXNG makes a single attempt regardless.
    return backup.search(query, numResults, {
      ...searchOptions,
      throwOnError: true,
      maxAttempts: SERPAPI_BACKUP_ATTEMPTS,
    });
  });

  // An empty answer rejects here so Promise.any keeps waiting for the other provider.
  const nonEmpty = (answer: Promise<WebSearchProviderResult[]>, provider: WebSearchProvider) =>
    answer.then(results => {
      if (results.length === 0) throw new EmptySearchAnswer();
      return { results, servedBy: provider };
    });

  try {
    return await Promise.any([nonEmpty(fromLead, lead), nonEmpty(fromBackup, backup)]);
  } catch (error) {
    const [leadError, backupError] = error instanceof AggregateError ? error.errors : [error, error];
    if (leadError instanceof EmptySearchAnswer) return { results: [], servedBy: lead };
    if (backupError instanceof EmptySearchAnswer) return { results: [], servedBy: backup };
    throw new Error(
      `Web search failed on both providers. ${lead.name}: ${errorMessage(leadError)}; ` +
        `${backup.name}: ${errorMessage(backupError)}`
    );
  }
}

export async function performWebSearch(
  adapters: GetEffectiveApiKeyAdapters,
  params: WebSearchParams,
  imageUrlSigningSecret = '',
  resolvedProvider?: Promise<WebSearchProvider | null>,
  resolvedBackup?: Promise<WebSearchProvider | null>
): Promise<WebSearchResult> {
  Logger.globalInstance.log('🔍 WebSearch Tool: Starting search for query:', params.query);

  // Surface a clear "not configured" message instead of silently returning
  // "No results found", which reads to the model (and user) as if the web
  // genuinely had nothing - the exact confusion this tool's gating fixes.
  const [provider, defaultBackup] = resolvedProvider
    ? [await resolvedProvider, null]
    : await resolveWebSearchProviders(adapters);
  if (!provider) {
    Logger.globalInstance.error('❌ WebSearch Tool: No web-search provider configured. Skipping search.');
    return { formattedResults: WEB_SEARCH_NOT_CONFIGURED_MSG, citables: [] };
  }

  try {
    const searchOptions = params.include_places ? { locationInQuery: true } : undefined;
    const numResults = params.num_results ?? 3;
    const isPlaceSearch = !!params.include_places;

    const cached = searchCacheGet(params.query, numResults, isPlaceSearch);
    let results: WebSearchProviderResult[];
    let servedBy = provider;
    if (cached) {
      Logger.globalInstance.log('WebSearch Tool: cache hit', { query: params.query });
      results = cached;
    } else {
      const backup = (await resolvedBackup) ?? defaultBackup;
      ({ results, servedBy } = await searchWithHedge(provider, backup, params.query, numResults, searchOptions));
      if (results.length > 0) searchCacheSet(params.query, numResults, results, isPlaceSearch);
    }
    Logger.globalInstance.log(
      `📊 WebSearch Tool: ${servedBy.name} found ${results.length} results${cached ? ' (cached)' : ''}`
    );

    // An unconfigured/placeholder signing secret can never produce a verifiable image URL - every
    // tile would render "Image unavailable" while still paying for the extra provider call and
    // showing the model the cards prompt. Degrade to plain prose instead, same as if the model
    // never asked for images at all.
    const canSignImages = !isPlaceholderImageSigningSecret(imageUrlSigningSecret);
    const wantsImages = !!params.include_images && canSignImages;

    // Only on a visual query: this is a second paid provider call, so it stays behind the model's
    // own `include_images` flag and never runs on an ordinary search.
    const anchorQuery = params.include_places ? params.anchor_location?.trim() : undefined;
    // Only on a location query: each is another paid provider call, behind the model's own flag.
    const [imageResults, placeResults, anchorResults] = await Promise.all([
      wantsImages ? servedBy.searchImages?.(params.query, undefined, searchOptions) : undefined,
      params.include_places ? servedBy.searchPlaces?.(params.query) : undefined,
      anchorQuery ? servedBy.searchPlaces?.(anchorQuery, 1) : undefined,
    ]).then(all => all.map(result => result ?? []) as [WebSearchImageResult[], WebSearchPlace[], WebSearchPlace[]]);
    const anchor = anchorResults[0];
    const places = placeResults.filter(place => place.id !== anchor?.id);
    const withPlaces = shouldIncludePlaces(places, params.include_places);
    if (placeResults.length) {
      Logger.globalInstance.log(`WebSearch Tool: ${servedBy.name} found ${placeResults.length} places`);
    }
    if (imageResults.length) {
      Logger.globalInstance.log(`🖼️ WebSearch Tool: ${servedBy.name} found ${imageResults.length} images`);
    }

    const withImages = shouldIncludeImages(results, wantsImages, imageResults);

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
        // Only ever set when images were actually requested/found - keeps the "byte-identical
        // output when include_images is unset" contract honest for the stored citable too, not
        // just the text output below.
        ...(withImages && result.thumbnail ? { thumbnail: result.thumbnail, images: result.images } : {}),
      },
    }));
    if (withPlaces) {
      for (const place of anchor ? [anchor, ...places] : places) {
        citables.push(placeCitable(place, imageUrlSigningSecret, canSignImages));
      }
    }

    const formattedResults = results
      .map((result, index) => {
        const imageLine =
          withImages && result.images?.length
            ? `Images: ${result.images.map(url => signImageUrl(url, imageUrlSigningSecret)).join(' | ')}\n`
            : '';
        // A hostile page's own title/snippet can carry raw newlines, same risk stripNewlines
        // already closes for the image pool's fields - here it would let a snippet forge a fake
        // numbered entry or a fake "Images:" line in this line-structured output.
        return (
          `${index + 1}. **${stripNewlines(result.title)}**\n${stripNewlines(result.snippet)}\n` +
          imageLine +
          `Source: [${safeHostname(result.url)}](${result.url})\n`
        );
      })
      .join('\n');

    const imageSection =
      withImages && imageResults.length ? `\n${formatImageResults(imageResults, imageUrlSigningSecret)}\n` : '';

    // Composed from its parts rather than gated as a whole on `formattedResults`: a query can
    // return zero organic hits but a real image cluster (the dedicated image search runs
    // independently of the organic search), and that image cluster - plus the cards prompt telling
    // the model how to use it - must not be thrown away just because there's no prose to go with it.
    const placeSection = withPlaces ? `\n${formatPlaceResults(places, anchor)}\n` : '';
    const baseText = formattedResults
      ? `Here's what I found from searching the web:\n\n${formattedResults}`
      : imageSection || placeSection
        ? "Here's what I found from searching the web:\n"
        : 'No results found from web search.';
    const formattedOutput =
      baseText +
      imageSection +
      placeSection +
      (withImages ? `\n${WEB_SEARCH_CARDS_PROMPT}` : '') +
      (withPlaces ? `\n${WEB_SEARCH_MAP_PROMPT}` : '');

    return { formattedResults: formattedOutput, citables };
  } catch (error) {
    Logger.globalInstance.error('❌ WebSearch Tool: Error during search:', error);
    throw error;
  }
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  implementation: (context: ToolContext, config?: WebSearchToolConfig) => {
    let searchCallCount = 0;
    let providersPromise: Promise<[WebSearchProvider | null, WebSearchProvider | null]> | undefined;
    return {
      toolFn: async value => {
        const params = value as WebSearchParams;
        const callNumber = ++searchCallCount;
        await context.onStart?.('web_search', params);
        providersPromise ??= resolveWebSearchProviders({ db: context.db }).catch(error => {
          providersPromise = undefined;
          throw error;
        });
        const startedAt = Date.now();
        const [lead, backup] = await providersPromise;
        // A failure throws on purpose: the backend hands the error text to the model as the tool
        // result AND records the call as failed, which is what the answer diagnosis reads.
        const { formattedResults, citables } = await performWebSearch(
          { db: context.db },
          params,
          config?.imageUrlSigningSecret,
          Promise.resolve(lead),
          Promise.resolve(backup)
        );
        context.logger.log('🔍 WebSearch Tool: search timing', {
          callNumber,
          query: params.query,
          durationMs: Date.now() - startedAt,
          resultCount: citables.length,
        });

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
            include_places: {
              type: 'boolean',
              description:
                'Set true when the answer is a set of PLACES the user would want to see on a map - restaurants, bars, cafes, shops, hotels, attractions, things to do in or near somewhere. Decide this yourself: the user will not ask for a map. Adds places with map locations so you can show them with a b4m_map block. Leave unset for anything that is not about physical locations.',
            },
            anchor_location: {
              type: 'string',
              description:
                'With include_places: the reference place the user named that results should be near, as a searchable name with its city, e.g. "citizenM Copenhagen Radhuspladsen". Shown distinctly on the map. Omit when the user named none.',
            },
          },
          required: ['query'],
        },
      },
    };
  },
};
