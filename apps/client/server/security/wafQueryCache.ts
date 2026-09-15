/**
 * In-memory cache for WAF CloudWatch query results.
 *
 * Follows the same singleton + concurrent-deduplication pattern as secretCache.ts.
 * Lives in Lambda module scope - survives across warm invocations, resets on cold start.
 *
 * TTLs chosen to balance freshness vs CloudWatch Logs Insights cost:
 * - Logs Insights queries scan GBs of data and take up to 60s to complete.
 * - A 10-minute cache means at most 6 CloudWatch queries/hour per stage+range combo
 *   instead of one per admin page load.
 *
 * Error handling:
 * - Failed fetches are cached for ERROR_TTL_MS to prevent thundering herd when
 *   CloudWatch is throttling or temporarily unavailable.
 */

export const WAF_CACHE_TTL = {
  /** Raw blocked request list - slightly fresher for ops use. */
  blockedRequests: 5 * 60 * 1000, // 5 minutes
  /** Aggregated insights (top URIs, IPs, rate limit). */
  logsInsights: 10 * 60 * 1000, // 10 minutes
  /** CloudWatch Metrics traffic overview. */
  traffic: 5 * 60 * 1000, // 5 minutes
} as const;

/** How long to suppress retries after a fetcher failure. */
const ERROR_TTL_MS = 30 * 1000; // 30 seconds

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  isError?: boolean;
}

class WafQueryCacheManager {
  private static instance: WafQueryCacheManager;

  private cache = new Map<string, CacheEntry>();
  private loading = new Map<string, Promise<unknown>>();

  private constructor() {}

  public static getInstance(): WafQueryCacheManager {
    if (!WafQueryCacheManager.instance) {
      WafQueryCacheManager.instance = new WafQueryCacheManager();
    }
    return WafQueryCacheManager.instance;
  }

  /**
   * Returns the cached value for `key` if still fresh, otherwise calls `fetcher`,
   * caches the result for `ttlMs` milliseconds, and returns it.
   *
   * Concurrent calls with the same key share a single in-flight `fetcher` promise -
   * avoiding N simultaneous CloudWatch queries when multiple admins hit the endpoint
   * at the same time on a warm Lambda instance.
   *
   * Failed fetches are cached for ERROR_TTL_MS to prevent a retry storm when
   * CloudWatch is throttling or temporarily unavailable.
   */
  public async getOrFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      if (hit.isError) throw hit.value;
      return hit.value as T;
    }

    const inflight = this.loading.get(key);
    if (inflight) {
      return inflight as Promise<T>;
    }

    const promise = (async () => {
      try {
        const value = await fetcher();
        this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
      } catch (err) {
        // Cache the error briefly to prevent a thundering herd on sustained failures.
        this.cache.set(key, { value: err, expiresAt: Date.now() + ERROR_TTL_MS, isError: true });
        throw err;
      } finally {
        this.loading.delete(key);
      }
    })();

    this.loading.set(key, promise);
    return promise;
  }

  /** Evict all entries whose key starts with `prefix`, or the entire cache if omitted. */
  public invalidate(prefix?: string): void {
    if (!prefix) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
}

export const wafQueryCache = WafQueryCacheManager.getInstance();
