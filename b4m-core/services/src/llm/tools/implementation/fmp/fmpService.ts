/**
 * Shared FMP (Financial Modeling Prep) API service.
 *
 * Provides stock quotes, company profiles, financial statements, and
 * historical price data with an in-memory cache (60 s TTL) to respect
 * FMP rate limits.  All functions accept an explicit `apiKey` so both
 * the LLM tool (via apiKeyService) and the tavern (via systemSecretsManager)
 * can share this code.
 *
 * NOTE: apps/client/server/tavern/fmpService.ts has a parallel copy for
 * the tavern Lambda context. Keep cache/fetch logic in sync when fixing
 * bugs in either copy.
 */

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_SIZE = 100_000; // 100 KB safety cap
const MAX_CACHE_SIZE = 500;

// Types

export interface FmpQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changesPercentage: number;
  dayLow: number;
  dayHigh: number;
  yearLow: number;
  yearHigh: number;
  volume: number;
  avgVolume: number;
  marketCap: number;
  previousClose: number;
  open: number;
  eps: number;
  pe: number;
  exchange: string;
  timestamp: number;
}

export interface FmpQuoteShort {
  symbol: string;
  price: number;
  volume: number;
}

export interface FmpSearchResult {
  symbol: string;
  name: string;
  currency: string;
  stockExchange: string;
  exchangeShortName: string;
}

export interface FmpCompanyProfile {
  symbol: string;
  companyName: string;
  currency: string;
  exchangeShortName: string;
  industry: string;
  sector: string;
  mktCap: number;
  description: string;
  ceo: string;
  website: string;
  fullTimeEmployees: string;
  price: number;
  changes: number;
  ipoDate: string;
  country: string;
}

export interface FmpHistoricalPrice {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
  changePercent: number;
}

export interface FmpFinancialStatement {
  date: string;
  symbol: string;
  period: string;
  [key: string]: string | number;
}

// Cache

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Internal fetch helper

async function fmpFetch<T>(apiKey: string, path: string, params?: Record<string, string>): Promise<T | null> {
  const cacheKey = `${path}?${JSON.stringify(params ?? {})}`;
  const cached = getCached<T>(cacheKey);
  if (cached !== undefined) return cached;

  const url = new URL(`${FMP_BASE}${path}`);
  url.searchParams.set('apikey', apiKey);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const text = await res.text();
    if (text.length > MAX_RESPONSE_SIZE) return null;

    const data = JSON.parse(text) as T;
    setCache(cacheKey, data);
    return data;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

// Public API

/** Full quote for a single ticker. */
export async function getStockQuote(apiKey: string, symbol: string): Promise<FmpQuote | null> {
  const data = await fmpFetch<FmpQuote[]>(apiKey, `/quote/${encodeURIComponent(symbol.toUpperCase())}`);
  return data?.[0] ?? null;
}

/** Lightweight quote (price + volume only). */
export async function getStockQuoteShort(apiKey: string, symbol: string): Promise<FmpQuoteShort | null> {
  const data = await fmpFetch<FmpQuoteShort[]>(apiKey, `/quote-short/${encodeURIComponent(symbol.toUpperCase())}`);
  return data?.[0] ?? null;
}

/** Batch quote for multiple tickers in a single API call. */
export async function getMultipleQuotes(apiKey: string, symbols: string[]): Promise<FmpQuote[]> {
  if (symbols.length === 0) return [];
  const joined = symbols.map(s => s.toUpperCase()).join(',');
  const data = await fmpFetch<FmpQuote[]>(apiKey, `/quote/${encodeURIComponent(joined)}`);
  return data ?? [];
}

/** Search for tickers by company name or symbol. Filters to major US exchanges. */
export async function searchStocks(apiKey: string, query: string): Promise<FmpSearchResult[]> {
  const data = await fmpFetch<FmpSearchResult[]>(apiKey, '/search', {
    query,
    limit: '10',
    exchange: 'NASDAQ,NYSE',
  });
  return data ?? [];
}

/** Company profile / overview. */
export async function getCompanyProfile(apiKey: string, symbol: string): Promise<FmpCompanyProfile | null> {
  const data = await fmpFetch<FmpCompanyProfile[]>(apiKey, `/profile/${encodeURIComponent(symbol.toUpperCase())}`);
  return data?.[0] ?? null;
}

/** Historical daily prices. */
export async function getHistoricalPrices(
  apiKey: string,
  symbol: string,
  from?: string,
  to?: string
): Promise<FmpHistoricalPrice[]> {
  const params: Record<string, string> = {};
  if (from) params.from = from;
  if (to) params.to = to;
  const data = await fmpFetch<{ historical: FmpHistoricalPrice[] }>(
    apiKey,
    `/historical-price-full/${encodeURIComponent(symbol.toUpperCase())}`,
    params
  );
  return data?.historical ?? [];
}

/** Income statement (annual or quarterly). */
export async function getIncomeStatement(
  apiKey: string,
  symbol: string,
  period: 'annual' | 'quarter' = 'annual'
): Promise<FmpFinancialStatement[]> {
  const data = await fmpFetch<FmpFinancialStatement[]>(
    apiKey,
    `/income-statement/${encodeURIComponent(symbol.toUpperCase())}`,
    { period, limit: '4' }
  );
  return data ?? [];
}

/** Balance sheet (annual or quarterly). */
export async function getBalanceSheet(
  apiKey: string,
  symbol: string,
  period: 'annual' | 'quarter' = 'annual'
): Promise<FmpFinancialStatement[]> {
  const data = await fmpFetch<FmpFinancialStatement[]>(
    apiKey,
    `/balance-sheet-statement/${encodeURIComponent(symbol.toUpperCase())}`,
    { period, limit: '4' }
  );
  return data ?? [];
}
