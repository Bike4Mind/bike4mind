/**
 * Fetch hourly token usage per model from provider admin usage APIs.
 *
 * Unlike providerSpendFetchers.ts (daily billed cost), these report tokens per model in hourly
 * buckets within minutes of the call, so a spend signal can be derived the same hour. A non-ok
 * HTTP response throws so the caller can tell a failed read from an idle hour.
 */

/** Per-request timeout for provider API calls (ms). */
const FETCH_TIMEOUT_MS = 30_000;

/** Upper bound on pages for one window; an hourly window grouped by model needs one or two. */
const MAX_PAGES = 20;

/** One model's token usage in one hourly bucket. `inputTokens` excludes cache reads and writes. */
export interface ProviderHourlyUsage {
  bucketStart: Date;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// -- Anthropic Admin API ------------------------------------------------

/**
 * Anthropic Usage Report: GET /v1/organizations/usage_report/messages
 * Requires an Admin API key. Cache writes are the 5-minute plus 1-hour ephemeral creations.
 */
export async function fetchAnthropicHourlyUsage(
  adminApiKey: string,
  startIso: string,
  endIso: string
): Promise<ProviderHourlyUsage[]> {
  const rows: ProviderHourlyUsage[] = [];
  let page: string | undefined;
  let pages = 0;

  do {
    if (++pages > MAX_PAGES) throw new Error(`Anthropic usage: exceeded ${MAX_PAGES} page limit (stuck cursor?)`);
    const url = new URL('https://api.anthropic.com/v1/organizations/usage_report/messages');
    url.searchParams.set('starting_at', startIso);
    url.searchParams.set('ending_at', endIso);
    url.searchParams.set('bucket_width', '1h');
    url.searchParams.append('group_by[]', 'model');
    url.searchParams.set('limit', '168');
    if (page) url.searchParams.set('page', page);

    const res = await fetchWithTimeout(url.toString(), {
      headers: {
        'x-api-key': adminApiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as AnthropicUsageResponse;

    for (const bucket of data.data ?? []) {
      const bucketStart = new Date(bucket.starting_at ?? startIso);
      for (const item of bucket.results ?? []) {
        rows.push({
          bucketStart,
          model: typeof item.model === 'string' && item.model ? item.model : 'unknown',
          inputTokens: count(item.uncached_input_tokens),
          outputTokens: count(item.output_tokens),
          cacheReadTokens: count(item.cache_read_input_tokens),
          cacheWriteTokens:
            count(item.cache_creation?.ephemeral_5m_input_tokens) +
            count(item.cache_creation?.ephemeral_1h_input_tokens),
        });
      }
    }

    page = data.has_more && data.next_page ? data.next_page : undefined;
  } while (page);

  return rows;
}

interface AnthropicUsageItem {
  model?: unknown;
  uncached_input_tokens?: unknown;
  cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown };
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
}

interface AnthropicUsageResponse {
  data?: Array<{ starting_at?: string; ending_at?: string; results?: AnthropicUsageItem[] }>;
  has_more?: boolean;
  next_page?: string | null;
}

// -- OpenAI Usage API ---------------------------------------------------

/**
 * OpenAI: GET /v1/organization/usage/completions
 * Requires an admin API key. `input_tokens` includes cached reads, so they are subtracted here.
 */
export async function fetchOpenAIHourlyUsage(
  adminApiKey: string,
  startUnix: number,
  endUnix: number
): Promise<ProviderHourlyUsage[]> {
  const rows: ProviderHourlyUsage[] = [];
  let page: string | undefined;
  let pages = 0;

  do {
    if (++pages > MAX_PAGES) throw new Error(`OpenAI usage: exceeded ${MAX_PAGES} page limit (stuck cursor?)`);
    const url = new URL('https://api.openai.com/v1/organization/usage/completions');
    url.searchParams.set('start_time', String(startUnix));
    url.searchParams.set('end_time', String(endUnix));
    url.searchParams.set('bucket_width', '1h');
    url.searchParams.append('group_by[]', 'model');
    url.searchParams.set('limit', '168');
    if (page) url.searchParams.set('page', page);

    const res = await fetchWithTimeout(url.toString(), {
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as OpenAIUsageResponse;

    for (const bucket of data.data ?? []) {
      const bucketStart = new Date((bucket.start_time ?? startUnix) * 1000);
      for (const item of bucket.results ?? []) {
        const input = count(item.input_tokens);
        const cached = Math.min(count(item.input_cached_tokens), input);
        rows.push({
          bucketStart,
          model: typeof item.model === 'string' && item.model ? item.model : 'unknown',
          inputTokens: input - cached,
          outputTokens: count(item.output_tokens),
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
        });
      }
    }

    page = data.has_more && data.next_page ? data.next_page : undefined;
  } while (page);

  return rows;
}

interface OpenAIUsageItem {
  model?: unknown;
  input_tokens?: unknown;
  input_cached_tokens?: unknown;
  output_tokens?: unknown;
}

interface OpenAIUsageResponse {
  data?: Array<{ start_time?: number; end_time?: number; results?: OpenAIUsageItem[] }>;
  has_more?: boolean;
  next_page?: string | null;
}

// -- Helpers ------------------------------------------------------------

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}
