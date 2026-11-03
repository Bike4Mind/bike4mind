import {
  FIRECRAWL_FETCH_COST_USD_DEFAULT,
  SERPAPI_SEARCH_COST_USD_DEFAULT,
  usdToCredits,
  type CompletionSource,
} from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository, usageEventRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { firecrawlFetch } from '@bike4mind/services/llm/tools/implementation/webfetch';
import { performWebSearch, resolveWebSearchProviders } from '@bike4mind/services/llm/tools/implementation/websearch';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { randomUUID } from 'node:crypto';
import { reserveRequestCredits } from '@server/billing/reserveRequestCredits';

/** What reserveRequestCredits reads off a request; a CLI or WebSocket caller builds the same slice by hand. */
export type WebToolCaller = Parameters<typeof reserveRequestCredits>[0]['req'];

type WebFetchResult = Awaited<ReturnType<typeof firecrawlFetch>>;

type BilledCall = {
  caller: WebToolCaller;
  source: CompletionSource;
};

const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } };

/** Credits for one provider call: the platform's markup applied to its USD cost, rounded up. A free call is 0, not 1. */
export const creditsForUsd = (usd: number): number => (usd > 0 ? usdToCredits(usd) : 0);

/** Hosted Firecrawl bills per scrape. A self-hosted `apiUrl`, or no Firecrawl at all (plain fetch), costs us nothing. */
export function isHostedFirecrawl({ apiKey, apiUrl }: { apiKey?: string; apiUrl?: string }): boolean {
  if (!apiKey) return false;
  if (!apiUrl) return true;
  try {
    return new URL(apiUrl).hostname === 'api.firecrawl.dev';
  } catch {
    return false;
  }
}

async function readPrices() {
  // Fresh read, like the other billing routes: a price or enforceCredits change applies at once.
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['enforceCredits', 'SerpApiSearchCostUsd', 'FirecrawlFetchCostUsd'], skipCache: true }
  );
  return {
    enforceCredits: getSettingsValue('enforceCredits', settings),
    searchUsd: getSettingsValue('SerpApiSearchCostUsd', settings, SERPAPI_SEARCH_COST_USD_DEFAULT),
    fetchUsd: getSettingsValue('FirecrawlFetchCostUsd', settings, FIRECRAWL_FETCH_COST_USD_DEFAULT),
  };
}

/** Analytics only (COGS per provider call); never part of the billing path. */
async function recordToolUsage(
  { caller, source }: BilledCall,
  requestId: string,
  reservation: Awaited<ReturnType<typeof reserveRequestCredits>>,
  event: { provider: string; model: string; costUsd: number; creditsCharged: number; status: 'ok' | 'error' }
): Promise<void> {
  try {
    await usageEventRepository.record({
      requestId,
      userId: caller.user!.id,
      ownerId: reservation.ownerId,
      ownerType: reservation.ownerType,
      sessionId: requestId,
      feature: 'tool',
      source,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      units: 1,
      ...event,
    });
  } catch (err) {
    caller.logger.warn('Failed to record web tool usage event', { err });
  }
}

/**
 * Settle a billed provider call for `charged` credits; anything else (a failure, a cache hit, a
 * keyless provider) refunds the whole hold.
 */
async function finish(
  call: BilledCall,
  reservation: Awaited<ReturnType<typeof reserveRequestCredits>>,
  requestId: string,
  tool: 'web_search' | 'web_fetch',
  outcome: { provider: string; costUsd: number; credits: number } | null
): Promise<void> {
  if (!outcome) {
    await reservation.refund();
    return;
  }
  const creditsCharged = await reservation.settle(outcome.credits, {
    type: 'tool_usage',
    questId: requestId,
    sessionId: requestId,
    // Provider and tool, the way the audio tool qualifies a vendor with no model id.
    model: `${outcome.provider}-${tool}`,
    source: call.source,
  });
  await recordToolUsage(call, requestId, reservation, {
    provider: outcome.provider,
    model: tool,
    costUsd: outcome.costUsd,
    creditsCharged,
    status: 'ok',
  });
}

/**
 * One web_search, billed to the caller's account (or its organization's pool, by the same rule as every
 * other paid route; see reserveRequestCredits). The cost is reserved BEFORE the provider is called, so an
 * account that cannot cover it gets a 422 `insufficient_credits` and no provider call is made.
 *
 * Only the provider that actually answered is charged: SerpAPI at SerpApiSearchCostUsd, while SearXNG
 * (self-hosted), a cache hit and an unconfigured search are free and release the hold. Only `query` and
 * `num_results` are honored, so one billed call is one provider call (place and image search each add more).
 */
export async function billedWebSearch(
  call: BilledCall,
  params: { query: string; num_results?: number }
): Promise<Awaited<ReturnType<typeof performWebSearch>>> {
  const prices = await readPrices();
  const providers = resolveWebSearchProviders(dbAdapters);
  const [lead, backup] = await providers;
  const credits = creditsForUsd(prices.searchUsd);
  // A hedged search may start SerpAPI as either the lead or the backup, so hold for it either way.
  const mayUseSerpApi = lead?.name === 'serpapi' || backup?.name === 'serpapi';

  const reservation = await reserveRequestCredits({
    req: call.caller,
    requiredCredits: mayUseSerpApi ? credits : 0,
    enforceCredits: prices.enforceCredits,
    featureLabel: 'web search',
  });
  const requestId = `web-search-${randomUUID()}`;

  let result: Awaited<ReturnType<typeof performWebSearch>>;
  try {
    result = await performWebSearch(
      dbAdapters,
      { query: params.query, num_results: params.num_results },
      '',
      providers
    );
  } catch (error) {
    await reservation.refund();
    throw error;
  }
  await finish(
    call,
    reservation,
    requestId,
    'web_search',
    result.servedBy === 'serpapi' ? { provider: 'serpapi', costUsd: prices.searchUsd, credits } : null
  );
  return result;
}

/**
 * One web_fetch, billed like billedWebSearch. Only hosted Firecrawl costs us money, so a self-hosted
 * Firecrawl or the keyless direct fetch is free. A failed fetch refunds the hold.
 */
export async function billedWebFetch(
  call: BilledCall,
  params: { url: string; offset?: number; maxTimeoutMs?: number }
): Promise<WebFetchResult> {
  const prices = await readPrices();
  const hosted = isHostedFirecrawl(await apiKeyService.getFirecrawlConfig(dbAdapters));
  const credits = creditsForUsd(prices.fetchUsd);

  const reservation = await reserveRequestCredits({
    req: call.caller,
    requiredCredits: hosted ? credits : 0,
    enforceCredits: prices.enforceCredits,
    featureLabel: 'web fetch',
  });
  const requestId = `web-fetch-${randomUUID()}`;

  let result: WebFetchResult;
  try {
    result = await firecrawlFetch(dbAdapters, params.url, {
      offset: params.offset,
      ...(params.maxTimeoutMs !== undefined && { maxTimeoutMs: params.maxTimeoutMs }),
    });
  } catch (error) {
    await reservation.refund();
    throw error;
  }
  await finish(
    call,
    reservation,
    requestId,
    'web_fetch',
    hosted ? { provider: 'firecrawl', costUsd: prices.fetchUsd, credits } : null
  );
  return result;
}
