import { Logger } from '@bike4mind/observability';
import type { WebSearchPlace } from '@bike4mind/common';
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

/**
 * One picture found by a dedicated image search, carrying its OWN page and publisher. Attribution is
 * correct by construction here - unlike an image lifted from a sibling array of a web search, this
 * one is never guessed onto a different result.
 */
export interface WebSearchImageResult {
  /** Full-size image file. */
  url: string;
  /** The page the picture appears on, used as the card's click-through. */
  pageUrl: string;
  title: string;
  /** Publisher name as the provider reports it, e.g. "Teddy Baldassarre". */
  source: string;
}

/** A web-search backend. `search` never assumes results exist and tolerates malformed responses. */
export interface WebSearchProvider {
  name: 'serpapi' | 'searxng';
  search(query: string, numResults?: number, options?: WebSearchOptions): Promise<WebSearchProviderResult[]>;
  /**
   * Dedicated image search, for a query the model flagged as visual. Optional: a provider without
   * one simply contributes no pictures. This exists because a plain web search usually carries NO
   * usable images at all - `organic_results[].thumbnail` is sparse, and `inline_images` belongs to
   * pages that are mostly absent from the same response - so relying on it alone leaves a visual
   * question answered in prose.
   */
  searchImages?(query: string, limit?: number): Promise<WebSearchImageResult[]>;
  /**
   * Place search with provider coordinates, for a query the model flagged as location-based. The
   * inline map pins come ONLY from here, never from coordinates the model writes. Optional, and
   * failures resolve to [] - a missing map degrades the reply to prose, it never fails the search.
   * `thumbnail` is the provider's raw URL; the caller signs it before it reaches the model.
   */
  searchPlaces?(query: string, limit?: number): Promise<WebSearchPlace[]>;
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
// Request timeout for the image/places/SearXNG paths (single attempt, no retry). These already
// fail soft to [] rather than surfacing an error to the user, so they keep the original 60s
// budget unchanged. The primary organic search below no longer shares this constant - see
// SERPAPI_ATTEMPT_TIMEOUT_MS, which is shorter and retried once.
const SEARCH_TIMEOUT_MS = 60_000;
// Per-attempt timeout for serpApiSearch's organic search, retried once (SERPAPI_MAX_ATTEMPTS) -
// short enough that a stalled SerpAPI response no longer holds the web_search tool call for
// anywhere near the old 60s.
const SERPAPI_ATTEMPT_TIMEOUT_MS = 20_000;
// serpApiSearch attempts: the original request plus exactly one retry.
const SERPAPI_MAX_ATTEMPTS = 2;
// Fixed delay before the retry. Worst case for the organic search alone is two full attempt
// timeouts plus this delay (20s + 20s + 0.5s = 40.5s) - an improvement over the old flat 60s,
// but not a bound on the whole tool call: index.ts runs the image/places searches AFTER the
// organic search returns, each still on its own untouched 60s SEARCH_TIMEOUT_MS fail-soft budget.
const SERPAPI_RETRY_DELAY_MS = 500;
// Citables are persisted with the quest, so keep the per-hit image list bounded.
const MAX_IMAGES_PER_RESULT = 4;
// Enough to build a card row from without flooding the model's context with URLs.
const DEFAULT_IMAGE_RESULTS = 12;
// A useful map's worth of pins; each costs the model a few lines of context.
const DEFAULT_PLACE_RESULTS = 10;

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A normalized place, or undefined when the entry has no name, id, or usable coordinates. */
function toPlace(fields: {
  id: unknown;
  name: unknown;
  lat: unknown;
  lng: unknown;
  rating?: unknown;
  reviews?: unknown;
  category?: unknown;
  address?: unknown;
  thumbnail?: unknown;
}): WebSearchPlace | undefined {
  const id = optionalText(fields.id);
  const name = optionalText(fields.name);
  const lat = finiteNumber(fields.lat);
  const lng = finiteNumber(fields.lng);
  if (!id || !name || lat === undefined || lng === undefined) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  const rating = finiteNumber(fields.rating);
  const reviews = finiteNumber(fields.reviews);
  const category = optionalText(fields.category);
  const address = optionalText(fields.address);
  const thumbnail = safeImageUrl(fields.thumbnail);
  return {
    id,
    name,
    lat,
    lng,
    ...(rating !== undefined ? { rating } : {}),
    ...(reviews !== undefined ? { reviews } : {}),
    ...(category ? { category } : {}),
    ...(address ? { address } : {}),
    ...(thumbnail ? { thumbnail } : {}),
  };
}

function dedupePlaces(places: (WebSearchPlace | undefined)[], limit: number): WebSearchPlace[] {
  const seen = new Set<string>();
  const result: WebSearchPlace[] = [];
  for (const place of places) {
    if (!place || seen.has(place.id)) continue;
    seen.add(place.id);
    result.push(place);
    if (result.length >= limit) break;
  }
  return result;
}

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

/**
 * Shape shared by SerpAPI's `inline_images` and `shopping_results` entries. The two spell the page
 * they belong to differently - `inline_images` uses `source`, `shopping_results` uses `link` - so
 * both are read; an entry carrying neither cannot be attributed to a hit and is dropped.
 */
interface SerpApiImageResult {
  source?: string;
  link?: string;
  original?: string;
  thumbnail?: string;
}

interface SerpApiResponse {
  organic_results?: SerpApiOrganicResult[];
  inline_images?: SerpApiImageResult[];
  shopping_results?: SerpApiImageResult[];
}

/** An entry of the `google_images` engine's `images_results`. */
interface SerpApiImagesEngineResult {
  title?: string;
  /** The page the image appears on. */
  link?: string;
  /** Publisher display name. */
  source?: string;
  original?: string;
  thumbnail?: string;
}

interface SerpApiImagesResponse {
  images_results?: SerpApiImagesEngineResult[];
}

/**
 * `inline_images` and `shopping_results` are sibling arrays rather than nested under the organic
 * hits, so they are attached by exact link match only - a positional or same-host guess would
 * caption a result with another page's picture.
 */
function indexImagesByLink(
  inlineImages: SerpApiImageResult[] | undefined,
  shoppingResults: SerpApiImageResult[] | undefined
): Map<string, string[]> {
  const byLink = new Map<string, string[]>();
  // Each group is keyed by its OWN documented field (see the SerpApiImageResult comment) - a
  // shared `source ?? link` fallback would silently key `shopping_results` by its merchant display
  // name (never a URL, so it can never match an organic hit's `link`), leaving that half of the
  // pool dead without any test noticing.
  const addGroup = (group: SerpApiImageResult[] | undefined, pageLinkField: 'source' | 'link') => {
    if (!Array.isArray(group)) return;
    for (const entry of group) {
      if (!entry) continue;
      const pageLink = entry[pageLinkField];
      if (typeof pageLink !== 'string' || !pageLink) continue;
      // `original` is the full-size picture on the publisher's own host; `thumbnail` is a ~100px
      // gstatic preview that visibly pixelates once a card tile scales it up. Prefer the former.
      const image = safeImageUrl(entry.original) ?? safeImageUrl(entry.thumbnail);
      if (!image) continue;
      byLink.set(pageLink, [...(byLink.get(pageLink) ?? []), image]);
    }
  };
  addGroup(inlineImages, 'source');
  addGroup(shoppingResults, 'link');
  return byLink;
}

/** A single serpApiSearch attempt that failed, tagged with enough context to decide on retry. */
type SerpApiAttemptFailure = {
  ok: false;
  /** Timeout/abort, network error, or HTTP 429/5xx - anything else fails immediately. */
  retryable: boolean;
  timedOut: boolean;
  status?: number;
  error: Error;
};

type SerpApiAttemptResult = { ok: true; data: SerpApiResponse } | SerpApiAttemptFailure;

/** True for the AbortController-driven rejection our own per-attempt timeout produces. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One SerpAPI organic-search attempt, bounded by SERPAPI_ATTEMPT_TIMEOUT_MS. Never throws -
 * failures (timeout, network error, non-OK response) come back as a tagged result so
 * serpApiSearch can decide whether to retry without duplicating the timeout/abort bookkeeping.
 */
async function attemptSerpApiRequest(url: URL, attempt: number): Promise<SerpApiAttemptResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SERPAPI_ATTEMPT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url.toString(), { method: 'GET', signal: controller.signal });
    Logger.globalInstance.log('📡 WebSearch Tool: SerpAPI response', {
      attempt,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
    });

    if (response.ok) return { ok: true, data: (await response.json()) as SerpApiResponse };

    const errorText = await response.text();
    Logger.globalInstance.error('❌ WebSearch Tool: API error details:', {
      status: response.status,
      statusText: response.statusText,
      errorText,
      endpoint: url.origin,
      attempt,
    });
    return {
      ok: false,
      retryable: response.status === 429 || response.status >= 500,
      timedOut: false,
      status: response.status,
      error: new Error(`SERP API error: ${response.statusText} - ${errorText}`),
    };
  } catch (error) {
    const timedOut = isAbortError(error);
    // A network-level failure (DNS, connection reset, TLS, ...) surfaces from fetch as a
    // TypeError; anything else is unexpected and is not treated as transient.
    const retryable = timedOut || error instanceof TypeError;
    Logger.globalInstance.error('❌ WebSearch Tool: SerpAPI request failed:', {
      attempt,
      timedOut,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      retryable,
      timedOut,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Builds the error `serpApiSearch` throws after every attempt has failed. Considers every
 * attempt, not only the last: if only the last attempt timed out, saying "SerpAPI did not
 * respond" is false when an earlier attempt got a concrete (retryable) response, e.g. attempt 1
 * an HTTP 503 and attempt 2 a timeout - the earlier response proves SerpAPI DID respond, just
 * not fast enough on the final try.
 */
function buildSerpApiFailureError(failures: SerpApiAttemptFailure[]): Error {
  const last = failures[failures.length - 1];
  if (!last) return new Error('SERP API error: request failed');
  if (!last.timedOut) return last.error;

  const earlierResponses = failures.slice(0, -1).filter(f => !f.timedOut);
  if (earlierResponses.length === 0) {
    // Every attempt made it timed out - the original message is accurate as-is.
    return new Error(
      `Web search timed out: SerpAPI did not respond within ${SERPAPI_ATTEMPT_TIMEOUT_MS / 1000}s (tried ${failures.length} times)`
    );
  }

  const earlierDescription = earlierResponses
    .map(f => (f.status !== undefined ? `HTTP ${f.status}` : f.error.message))
    .join('; ');
  return new Error(
    `Web search timed out: SerpAPI's last attempt did not respond within ${SERPAPI_ATTEMPT_TIMEOUT_MS / 1000}s ` +
      `(earlier attempt: ${earlierDescription})`
  );
}

/**
 * Raw SerpAPI (https://serpapi.com/search) call. Returns the organic results envelope; an empty
 * envelope when no key is configured (callers gate on the key before relying on this). Retries
 * once (SERPAPI_MAX_ATTEMPTS) on a timeout/abort, a network-level fetch failure, or an HTTP
 * 429/5xx; any other non-OK response (e.g. a bad key or bad params) fails immediately. Throws on
 * final failure so the tool surfaces it - two still-timed-out attempts throw an explicit "timed
 * out" error instead of the raw abort's generic DOMException message. Exported (re-exported from
 * index) for the REST endpoint and existing tests.
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

  const failures: SerpApiAttemptFailure[] = [];
  for (let attempt = 1; attempt <= SERPAPI_MAX_ATTEMPTS; attempt++) {
    const outcome = await attemptSerpApiRequest(url, attempt);
    if (outcome.ok) return outcome.data;
    failures.push(outcome);
    if (!outcome.retryable || attempt === SERPAPI_MAX_ATTEMPTS) break;
    Logger.globalInstance.log('📡 WebSearch Tool: retrying SerpAPI after transient failure', {
      attempt,
      status: outcome.status,
      timedOut: outcome.timedOut,
    });
    await sleep(SERPAPI_RETRY_DELAY_MS);
  }

  throw buildSerpApiFailureError(failures);
}

/**
 * SerpAPI's dedicated image engine. A separate paid call, so it runs ONLY when the model set
 * `include_images` on a visual query. Failures resolve to [] - missing pictures degrade the reply
 * to prose, they never fail the search.
 */
async function serpApiImageSearch(
  adapters: GetEffectiveApiKeyAdapters,
  query: string,
  limit: number
): Promise<WebSearchImageResult[]> {
  const apiKey = await getSerperKey(adapters);
  if (!apiKey) return [];

  const url = new URL('https://serpapi.com/search');
  url.search = new URLSearchParams({
    engine: 'google_images',
    api_key: apiKey,
    q: query,
    location: 'United States',
    google_domain: 'google.com',
    gl: 'us',
    hl: 'en',
    safe: 'active',
  }).toString();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      Logger.globalInstance.error('WebSearch Tool: SerpAPI image search failed', { status: response.status });
      return [];
    }
    const data = (await response.json()) as SerpApiImagesResponse;
    const entries = Array.isArray(data.images_results) ? data.images_results : [];

    const seen = new Set<string>();
    const images: WebSearchImageResult[] = [];
    for (const entry of entries) {
      if (!entry) continue;
      const image = safeImageUrl(entry.original) ?? safeImageUrl(entry.thumbnail);
      const pageUrl = typeof entry.link === 'string' ? entry.link : '';
      // A picture with no page cannot be attributed or linked, which is the whole point of a card.
      if (!image || !pageUrl || seen.has(image)) continue;
      seen.add(image);
      images.push({
        url: image,
        pageUrl,
        title: entry.title ?? '',
        source: entry.source || safeHost(pageUrl),
      });
      if (images.length >= limit) break;
    }
    return images;
  } catch (error) {
    Logger.globalInstance.error('WebSearch Tool: SerpAPI image search request failed:', error);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/** An entry of the `google_maps` engine's `local_results`, or its single-match `place_results`. */
interface SerpApiMapsPlace {
  title?: string;
  place_id?: string;
  gps_coordinates?: { latitude?: unknown; longitude?: unknown };
  rating?: unknown;
  reviews?: unknown;
  type?: string;
  address?: string;
  thumbnail?: string;
}

interface SerpApiMapsResponse {
  local_results?: SerpApiMapsPlace[];
  place_results?: SerpApiMapsPlace;
}

function fromSerpApiMapsPlace(entry: SerpApiMapsPlace | undefined): WebSearchPlace | undefined {
  if (!entry) return undefined;
  return toPlace({
    id: entry.place_id,
    name: entry.title,
    lat: entry.gps_coordinates?.latitude,
    lng: entry.gps_coordinates?.longitude,
    rating: entry.rating,
    reviews: entry.reviews,
    category: entry.type,
    address: entry.address,
    thumbnail: entry.thumbnail,
  });
}

/**
 * SerpAPI's `google_maps` engine. A separate paid call, so it runs ONLY when the model set
 * `include_places`. A query naming one specific place (the anchor lookup) comes back as a single
 * `place_results` object rather than a `local_results` list, so both are read.
 */
async function serpApiPlaceSearch(
  adapters: GetEffectiveApiKeyAdapters,
  query: string,
  limit: number
): Promise<WebSearchPlace[]> {
  const apiKey = await getSerperKey(adapters);
  if (!apiKey) return [];

  const url = new URL('https://serpapi.com/search');
  url.search = new URLSearchParams({
    engine: 'google_maps',
    type: 'search',
    api_key: apiKey,
    q: query,
    hl: 'en',
  }).toString();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      Logger.globalInstance.error('WebSearch Tool: SerpAPI place search failed', { status: response.status });
      return [];
    }
    const data = (await response.json()) as SerpApiMapsResponse;
    const local = Array.isArray(data.local_results) ? data.local_results : [];
    return dedupePlaces([fromSerpApiMapsPlace(data.place_results), ...local.map(fromSerpApiMapsPlace)], limit);
  } catch (error) {
    Logger.globalInstance.error('WebSearch Tool: SerpAPI place search request failed:', error);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Hostname of a URL, or the URL itself when it will not parse. */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function createSerpApiProvider(adapters: GetEffectiveApiKeyAdapters): WebSearchProvider {
  return {
    name: 'serpapi',
    searchImages: (query, limit) => serpApiImageSearch(adapters, query, limit ?? DEFAULT_IMAGE_RESULTS),
    searchPlaces: (query, limit) => serpApiPlaceSearch(adapters, query, limit ?? DEFAULT_PLACE_RESULTS),
    async search(query, numResults, options) {
      const data = await serpApiSearch(adapters, query, numResults, options);
      const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
      const extraImages = indexImagesByLink(data.inline_images, data.shopping_results);
      return organic
        .filter((r): r is SerpApiOrganicResult => !!r && typeof r.link === 'string')
        .map(r => {
          // `inline_images`/`shopping_results` carry the publisher's full-size picture, while
          // `organic_results[].thumbnail` is a ~92px preview. Order the big ones first so the card's
          // hero tile - the one scaled up the most - is not the most pixelated image available.
          const images = dedupeImages([...(extraImages.get(r.link!) ?? []), safeImageUrl(r.thumbnail)]);
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
 * Map-category SearXNG results (its OpenStreetMap/Photon engines) carry `latitude`/`longitude`
 * and an `osm` {type, id}; anything without coordinates is not a place and is skipped.
 */
function parseSearxngPlaces(data: unknown, limit: number): WebSearchPlace[] {
  if (typeof data !== 'object' || data === null) return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return dedupePlaces(
    results.map(item => {
      if (typeof item !== 'object' || item === null) return undefined;
      const record = item as Record<string, unknown>;
      const osm = record.osm as { type?: unknown; id?: unknown } | undefined;
      const osmId = osm && (typeof osm.id === 'number' || typeof osm.id === 'string') ? osm.id : undefined;
      const id = osmId !== undefined && typeof osm?.type === 'string' ? `${osm.type}/${osmId}` : record.url;
      const address = record.address as { name?: unknown; road?: unknown; locality?: unknown } | undefined;
      const addressText = address
        ? [address.road, address.locality].filter((part): part is string => typeof part === 'string').join(', ')
        : undefined;
      return toPlace({
        id,
        name: record.title,
        lat: record.latitude,
        lng: record.longitude,
        address: addressText,
        thumbnail: record.img_src ?? record.thumbnail,
      });
    }),
    limit
  );
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
    async searchPlaces(query, limit) {
      const url = new URL(`${baseUrl.replace(/\/+$/, '')}/search`);
      url.search = new URLSearchParams({ q: query, format: 'json', language: 'en', categories: 'map' }).toString();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      try {
        const response = await fetch(url.toString(), { method: 'GET', signal: controller.signal });
        if (!response.ok) {
          Logger.globalInstance.error('WebSearch Tool: SearXNG place search error', {
            status: response.status,
            statusText: response.statusText,
          });
          return [];
        }
        return parseSearxngPlaces(await response.json(), limit ?? DEFAULT_PLACE_RESULTS);
      } catch (error) {
        Logger.globalInstance.error('WebSearch Tool: SearXNG place search failed:', error);
        return [];
      } finally {
        clearTimeout(timeoutId);
      }
    },
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
