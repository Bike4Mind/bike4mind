/**
 * Fetch authoritative spend figures from provider billing APIs.
 *
 * Each fetcher returns a total USD amount for the given month and an optional
 * per-key/per-model breakdown. When a provider's admin key is not configured
 * the fetcher returns null (skip, not error).
 */

export interface ProviderSpendResult {
  providerUsd: number;
  breakdown: Record<string, number>;
  note?: string;
}

// -- Anthropic Admin API ------------------------------------------------

/**
 * Anthropic Admin API: GET /v1/organizations/usage
 * Requires an admin-scoped API key. Returns daily cost buckets; we sum them
 * for the requested month.
 *
 * Docs: https://docs.anthropic.com/en/docs/administration/administration-api
 *
 * TODO: paginate via cursor for orgs with many API keys.
 */
export async function fetchAnthropicSpend(adminApiKey: string, month: string): Promise<ProviderSpendResult | null> {
  if (!adminApiKey || adminApiKey === 'not-configured') return null;

  const { startDate, endDate } = monthToDateRange(month);

  const url = new URL('https://api.anthropic.com/v1/organizations/usage');
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  url.searchParams.set('grouping', 'api_key');

  const res = await fetch(url.toString(), {
    headers: {
      'x-api-key': adminApiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      providerUsd: 0,
      breakdown: {},
      note: `Anthropic API ${res.status}: ${body.slice(0, 200)}`,
    };
  }

  const data = (await res.json()) as AnthropicUsageResponse;
  const breakdown: Record<string, number> = {};
  let total = 0;

  for (const bucket of data.data ?? []) {
    const key = typeof bucket.api_key_name === 'string' ? bucket.api_key_name : 'unknown';
    const cost = typeof bucket.cost_usd === 'number' ? bucket.cost_usd : 0;
    breakdown[key] = (breakdown[key] ?? 0) + cost;
    total += cost;
  }

  return { providerUsd: total, breakdown };
}

interface AnthropicUsageBucket {
  api_key_name?: unknown;
  cost_usd?: unknown;
}

interface AnthropicUsageResponse {
  data?: AnthropicUsageBucket[];
}

// -- OpenAI Usage API ---------------------------------------------------

/**
 * OpenAI: GET /v1/organization/costs
 * Requires an admin API key. Returns daily cost buckets with line items.
 * Amounts are in USD (not cents).
 *
 * Docs: https://platform.openai.com/docs/api-reference/usage
 *
 * TODO: paginate via `next_page` cursor for orgs with many line items.
 */
export async function fetchOpenAISpend(adminApiKey: string, month: string): Promise<ProviderSpendResult | null> {
  if (!adminApiKey || adminApiKey === 'not-configured') return null;

  const { startTs, endTs } = monthToTimestampRange(month);

  const url = new URL('https://api.openai.com/v1/organization/costs');
  url.searchParams.set('start_time', String(startTs));
  url.searchParams.set('end_time', String(endTs));
  url.searchParams.set('group_by', 'line_item');

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${adminApiKey}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      providerUsd: 0,
      breakdown: {},
      note: `OpenAI API ${res.status}: ${body.slice(0, 200)}`,
    };
  }

  const data = (await res.json()) as OpenAICostsResponse;
  const breakdown: Record<string, number> = {};
  let total = 0;

  for (const bucket of data.data ?? []) {
    for (const item of bucket.results ?? []) {
      const lineItem = typeof item.line_item === 'string' ? item.line_item : 'unknown';
      const cost = typeof item.amount?.value === 'number' ? item.amount.value : 0;
      breakdown[lineItem] = (breakdown[lineItem] ?? 0) + cost;
      total += cost;
    }
  }

  return { providerUsd: total, breakdown };
}

interface OpenAICostLineItem {
  line_item?: unknown;
  amount?: { value?: number; currency?: string };
}

interface OpenAICostBucket {
  results?: OpenAICostLineItem[];
}

interface OpenAICostsResponse {
  data?: OpenAICostBucket[];
}

// -- Helpers ------------------------------------------------------------

function monthToDateRange(month: string): { startDate: string; endDate: string } {
  const [year, mo] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, mo - 1, 1));
  // First day of next month.
  const end = new Date(Date.UTC(year, mo, 1));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function monthToTimestampRange(month: string): { startTs: number; endTs: number } {
  const [year, mo] = month.split('-').map(Number);
  const startTs = Math.floor(new Date(Date.UTC(year, mo - 1, 1)).getTime() / 1000);
  const endTs = Math.floor(new Date(Date.UTC(year, mo, 1)).getTime() / 1000);
  return { startTs, endTs };
}
