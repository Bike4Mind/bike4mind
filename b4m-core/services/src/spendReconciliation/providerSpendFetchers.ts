/**
 * Fetch authoritative spend figures from provider billing APIs.
 *
 * Each fetcher returns a total USD amount for the given month and an optional
 * per-key/per-model breakdown. When a provider's admin key is not configured
 * the fetcher returns null (skip, not error). A non-ok HTTP response throws
 * so the cron can skip the month without persisting a false $0 snapshot.
 */

/** Per-request timeout for provider API calls (ms). */
const FETCH_TIMEOUT_MS = 30_000;

export interface ProviderSpendResult {
  providerUsd: number;
  breakdown: Record<string, number>;
}

// -- Anthropic Admin API ------------------------------------------------

/**
 * Anthropic Cost Report: GET /v1/organizations/cost_report
 * Requires an Admin API key (sk-ant-admin01-...).
 *
 * Params: starting_at / ending_at (RFC 3339), bucket_width=1d.
 * Response: { data: [{ results: [{ amount: "cents-string", ... }] }], has_more, next_page }
 * Amount is in lowest currency units (cents) as a decimal string.
 *
 * Docs: https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-cost-report
 */
export async function fetchAnthropicSpend(adminApiKey: string, month: string): Promise<ProviderSpendResult | null> {
  if (!adminApiKey || adminApiKey === 'not-configured') return null;

  const { startIso, endIso } = monthToIsoRange(month);
  const breakdown: Record<string, number> = {};
  let total = 0;
  let page: string | undefined;

  do {
    const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
    url.searchParams.set('starting_at', startIso);
    url.searchParams.set('ending_at', endIso);
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('group_by', 'description');
    url.searchParams.set('limit', '31');
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

    const data = (await res.json()) as AnthropicCostResponse;

    for (const bucket of data.data ?? []) {
      for (const item of bucket.results ?? []) {
        // amount is cents as a decimal string, e.g. "123.45" = $1.2345
        const cents = typeof item.amount === 'string' ? parseFloat(item.amount) : 0;
        if (!Number.isFinite(cents)) continue;
        const usd = cents / 100;
        const label = typeof item.description === 'string' ? item.description : 'other';
        breakdown[label] = (breakdown[label] ?? 0) + usd;
        total += usd;
      }
    }

    page = data.has_more ? data.next_page : undefined;
  } while (page);

  return { providerUsd: total, breakdown };
}

interface AnthropicCostItem {
  amount?: unknown;
  description?: unknown;
  cost_type?: unknown;
  model?: unknown;
}

interface AnthropicCostBucket {
  starting_at?: string;
  ending_at?: string;
  results?: AnthropicCostItem[];
}

interface AnthropicCostResponse {
  data?: AnthropicCostBucket[];
  has_more?: boolean;
  next_page?: string;
}

// -- OpenAI Usage API ---------------------------------------------------

/**
 * OpenAI: GET /v1/organization/costs
 * Requires an admin API key. Returns daily cost buckets.
 * Amounts are in USD as decimal numbers (not cents).
 * bucket_width only supports "1d"; limit defaults to 7 so we must paginate.
 *
 * Docs: https://developers.openai.com/cookbook/examples/completions_usage_api
 */
export async function fetchOpenAISpend(adminApiKey: string, month: string): Promise<ProviderSpendResult | null> {
  if (!adminApiKey || adminApiKey === 'not-configured') return null;

  const { startTs, endTs } = monthToTimestampRange(month);
  const breakdown: Record<string, number> = {};
  let total = 0;
  let afterTs = startTs;

  // OpenAI only supports bucket_width=1d and limit defaults to 7. A month
  // has up to 31 days, so we paginate by advancing start_time past the last
  // bucket we received. Guard against infinite loops from missing end_time.
  const MAX_OPENAI_PAGES = 40;
  let pages = 0;
  while (afterTs < endTs) {
    if (++pages > MAX_OPENAI_PAGES) {
      throw new Error(`OpenAI costs: exceeded ${MAX_OPENAI_PAGES} page limit (stuck cursor?)`);
    }
    const url = new URL('https://api.openai.com/v1/organization/costs');
    url.searchParams.set('start_time', String(afterTs));
    url.searchParams.set('end_time', String(endTs));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', '31');
    url.searchParams.set('group_by', 'line_item');

    const res = await fetchWithTimeout(url.toString(), {
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as OpenAICostsResponse;
    const buckets = data.data ?? [];
    if (buckets.length === 0) break;

    for (const bucket of buckets) {
      for (const item of bucket.results ?? []) {
        const lineItem = typeof item.line_item === 'string' ? item.line_item : 'other';
        const cost = typeof item.amount?.value === 'number' ? item.amount.value : 0;
        breakdown[lineItem] = (breakdown[lineItem] ?? 0) + cost;
        total += cost;
      }
      // Advance past this bucket for the next page.
      if (typeof bucket.end_time === 'number' && bucket.end_time > afterTs) {
        afterTs = bucket.end_time;
      }
    }

    // If fewer buckets than limit, we have all the data.
    if (buckets.length < 31) break;
  }

  return { providerUsd: total, breakdown };
}

interface OpenAICostLineItem {
  line_item?: unknown;
  amount?: { value?: number; currency?: string };
}

interface OpenAICostBucket {
  start_time?: number;
  end_time?: number;
  results?: OpenAICostLineItem[];
}

interface OpenAICostsResponse {
  data?: OpenAICostBucket[];
}

// -- Helpers ------------------------------------------------------------

function monthToIsoRange(month: string): { startIso: string; endIso: string } {
  const [year, mo] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, mo - 1, 1));
  // Anthropic docs: "Time buckets that end before this timestamp will be returned."
  // A daily bucket for the last day ends exactly at 00:00Z of the next month.
  // Adding 1 second makes the boundary inclusive of that final bucket.
  const end = new Date(Date.UTC(year, mo, 1, 0, 0, 1));
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function monthToTimestampRange(month: string): { startTs: number; endTs: number } {
  const [year, mo] = month.split('-').map(Number);
  const startTs = Math.floor(new Date(Date.UTC(year, mo - 1, 1)).getTime() / 1000);
  // Same boundary reasoning as monthToIsoRange: +1 second to include the
  // final daily bucket whose end_time equals midnight of the next month.
  const endTs = Math.floor(new Date(Date.UTC(year, mo, 1)).getTime() / 1000) + 1;
  return { startTs, endTs };
}

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}
