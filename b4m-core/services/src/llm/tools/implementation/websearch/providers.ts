import { Logger } from '@bike4mind/observability';
import {
  GetEffectiveApiKeyAdapters,
  getSerperKey,
  getSearxngUrl,
  getWebSearchProviderSetting,
} from '../../../../apiKeyService';

/** One normalized web-search hit, provider-agnostic. */
export interface WebSearchProviderResult {
  title: string;
  url: string;
  snippet: string;
  /** Provider-supplied image for this hit, absent when the provider gave none. Same as `images[0]`. */
  thumbnail?: string;
  /** Every image the provider supplied for this hit, deduped and capped. */
  images?: string[];
}

/**
 * Per-call search constraints beyond the query itself. Optional and additive: the chat `web_search`
 * tool passes none, so its behaviour is unchanged.
 */
export interface WebSearchOptions {
  /**
   * Only return pages the provider dates within this many days. Applied by the PROVIDER (SerpAPI
   * `tbs=qdr:`, SearXNG `time_range`), never after the fact - a normalized hit carries no
   * publication date, so a caller-side filter would have nothing to compare against.
   *
   * Both providers express recency as coarse buckets rather than an exact span, so this widens to
   * the smallest bucket that CONTAINS the window (see `recencyBucket`). Widening rather than
   * narrowing is the safe direction: an over-wide bucket returns some pages older than asked for,
   * where an under-wide one silently hides pages the caller wanted.
   */
  recencyDays?: number;
}

/** A web-search backend. `search` never assumes results exist and tolerates malformed responses. */
export interface WebSearchProvider {
  name: 'serpapi' | 'searxng';
  search(query: string, numResults?: number, options?: WebSearchOptions): Promise<WebSearchProviderResult[]>;
}

/**
 * The coarse recency bucket both providers speak, as the smallest one containing `recencyDays`.
 * Null when there is no constraint, or when the window is wider than the widest bucket - a
 * "within 10 years" filter is not a filter, and sending one would exclude undated pages for nothing.
 */
export function recencyBucket(recencyDays: number | undefined): 'day' | 'week' | 'month' | 'year' | null {
  if (typeof recencyDays !== 'number' || !Number.isFinite(recencyDays) || recencyDays <= 0) return null;
  if (recencyDays <= 1) return 'day';
  if (recencyDays <= 7) return 'week';
  if (recencyDays <= 31) return 'month';
  if (recencyDays <= 366) return 'year';
  return null;
}

/** SerpAPI spells the buckets `qdr:d|w|m|y` on the `tbs` parameter. */
const SERPAPI_QDR: Record<NonNullable<ReturnType<typeof recencyBucket>>, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
};

// Matches serpApiSearch's DEFAULT_NUM_RESULTS and the web_search tool schema default.
const DEFAULT_NUM_RESULTS = 3;
// Mirror serpApiSearch's request timeout so a hung provider fails the same way.
const SEARCH_TIMEOUT_MS = 60_000;
// Citables are persisted with the quest, so keep the per-hit image list bounded.
const MAX_IMAGES_PER_RESULT = 4;

/**
 * Only absolute https URLs are usable: the client reads these through /api/search-image, whose
 * SSRF guard rejects anything but https, and a data: URI would bloat every stored citable.
 */
function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function dedupeImages(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))].slice(0, MAX_IMAGES_PER_RESULT);
}

interface SerpApiOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  thumbnail?: string;
}

/** Shape shared by SerpAPI's `inline_images` and `shopping_results` entries. */
interface SerpApiImageResult {
  link?: string;
  original?: string;
  thumbnail?: string;
}

interface SerpApiResponse {
  organic_results?: SerpApiOrganicResult[];
  inline_images?: SerpApiImageResult[];
  shopping_results?: SerpApiImageResult[];
}

/**
 * `inline_images` and `shopping_results` are sibling arrays rather than nested under the organic
 * hits, so they are attached by exact link match only - a positional or same-host guess would
 * caption a result with another page's picture.
 */
function indexImagesByLink(...groups: (SerpApiImageResult[] | undefined)[]): Map<string, string[]> {
  const byLink = new Map<string, string[]>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (!entry || typeof entry.link !== 'string' || !entry.link) continue;
      const image = safeImageUrl(entry.thumbnail) ?? safeImageUrl(entry.original);
      if (!image) continue;
      byLink.set(entry.link, [...(byLink.get(entry.link) ?? []), image]);
    }
  }
  return byLink;
}

/**
 * Raw SerpAPI (https://serpapi.com/search) call. Returns the organic results envelope; an empty
 * envelope when no key is configured (callers gate on the key before relying on this), and throws
 * on a non-OK response so the tool surfaces the failure. Exported (re-exported from index) for the
 * REST endpoint and existing tests.
 */
export async function serpApiSearch(
  adapters: GetEffectiveApiKeyAdapters,
  query: string,
  num_results?: number,
  options?: WebSearchOptions
): Promise<SerpApiResponse> {
  const apiKey = await getSerperKey(adapters);
  const url = new URL('https://serpapi.com/search');

  if (!apiKey) {
    Logger.globalInstance.error('❌ WebSearch Tool: No API key configured. Skipping search.');
    return { organic_results: [] };
  }

  const searchParams = new URLSearchParams({
    engine: 'google',
    api_key: apiKey,
    q: query,
    location: 'United States',
    google_domain: 'google.com',
    gl: 'us',
    hl: 'en',
    num: (num_results || DEFAULT_NUM_RESULTS).toString(),
  });

  const bucket = recencyBucket(options?.recencyDays);
  if (bucket) searchParams.set('tbs', SERPAPI_QDR[bucket]);

  url.search = searchParams.toString();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

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

  return (await response.json()) as SerpApiResponse;
}

export function createSerpApiProvider(adapters: GetEffectiveApiKeyAdapters): WebSearchProvider {
  return {
    name: 'serpapi',
    async search(query, numResults, options) {
      const data = await serpApiSearch(adapters, query, numResults, options);
      const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
      const extraImages = indexImagesByLink(data.inline_images, data.shopping_results);
      return organic
        .filter((r): r is SerpApiOrganicResult => !!r && typeof r.link === 'string')
        .map(r => {
          const images = dedupeImages([safeImageUrl(r.thumbnail), ...(extraImages.get(r.link!) ?? [])]);
          return {
            title: r.title ?? r.link!,
            url: r.link!,
            snippet: r.snippet ?? '',
            ...(images.length > 0 ? { thumbnail: images[0], images } : {}),
          };
        });
    },
  };
}

/** Defensively map a SearXNG JSON `results` array into normalized hits; malformed input -> []. */
function parseSearxngResults(data: unknown, numResults: number): WebSearchProviderResult[] {
  if (typeof data !== 'object' || data === null) return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  const mapped: WebSearchProviderResult[] = [];
  for (const item of results) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url : '';
    if (!url) continue; // a hit with no URL cannot be cited
    const title = typeof record.title === 'string' ? record.title : '';
    const snippet = typeof record.content === 'string' ? record.content : '';
    const images = dedupeImages([
      safeImageUrl(record.img_src),
      safeImageUrl(record.thumbnail_src),
      safeImageUrl(record.thumbnail),
    ]);
    mapped.push({
      title: title || url,
      url,
      snippet,
      ...(images.length > 0 ? { thumbnail: images[0], images } : {}),
    });
  }
  return mapped.slice(0, numResults);
}

/**
 * SearXNG provider. Calls the admin-configured JSON search endpoint (trusted config, so NOT subject
 * to the SSRF guard). Any transport/parse failure (including the abort timeout) resolves to [] so a
 * flaky local instance degrades to "no results" instead of throwing, matching how search is best-
 * effort in the agent loop.
 */
export function createSearxngProvider(baseUrl: string): WebSearchProvider {
  return {
    name: 'searxng',
    async search(query, numResults, options) {
      const limit = numResults && numResults > 0 ? numResults : DEFAULT_NUM_RESULTS;
      const trimmed = baseUrl.replace(/\/+$/, '');
      const url = new URL(`${trimmed}/search`);
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        language: 'en',
        safesearch: '1',
      });
      // SearXNG names the same four buckets directly, so no mapping table is needed here.
      const bucket = recencyBucket(options?.recencyDays);
      if (bucket) params.set('time_range', bucket);
      url.search = params.toString();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      try {
        const response = await fetch(url.toString(), { method: 'GET', signal: controller.signal });
        if (!response.ok) {
          Logger.globalInstance.error('❌ WebSearch Tool: SearXNG error', {
            status: response.status,
            statusText: response.statusText,
          });
          return [];
        }
        const data: unknown = await response.json();
        return parseSearxngResults(data, limit);
      } catch (error) {
        Logger.globalInstance.error('❌ WebSearch Tool: SearXNG request failed:', error);
        return [];
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

/**
 * Resolve the active web-search provider, or null when none is configured. Precedence:
 *   - explicit admin choice ('serpapi' | 'searxng') forces that provider (null if it's unconfigured)
 *   - 'auto' (default): SearXNG if a URL is configured (admin setting or SEARXNG_BASE_URL env),
 *     else SerpAPI if a Serper key is set, else null.
 * Mirrored by computeToolAvailability in serverConfig.ts so the picker's gating matches the tool.
 */
export async function resolveWebSearchProvider(
  adapters: GetEffectiveApiKeyAdapters
): Promise<WebSearchProvider | null> {
  const choice = (await getWebSearchProviderSetting(adapters)) ?? 'auto';
  const searxngUrl = await getSearxngUrl(adapters);
  const serperKey = await getSerperKey(adapters);

  if (choice === 'searxng') {
    return searxngUrl ? createSearxngProvider(searxngUrl) : null;
  }
  if (choice === 'serpapi') {
    return serperKey ? createSerpApiProvider(adapters) : null;
  }
  // auto
  if (searxngUrl) return createSearxngProvider(searxngUrl);
  if (serperKey) return createSerpApiProvider(adapters);
  return null;
}
