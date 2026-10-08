import { paginatedResponseSchema, PublicReleaseNoteSchema, type PublicReleaseNote } from '@bike4mind/common';
import { safeFetch } from '@server/utils/ssrfProtection';

export type UpstreamFeedPage = { data: PublicReleaseNote[]; next_cursor: string | null };
type Logger = { warn: (message: string, meta?: Record<string, unknown>) => void };

const TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 256 * 1024;
const OK_TTL_MS = 60_000;
// After an upstream-wide failure every request falls back without fetching for this long, so a dead
// upstream costs one timeout per window rather than one per request (or per distinct cursor).
const OUTAGE_TTL_MS = 30_000;
// Only first pages are cached, keyed by limit (1-100), so no request can push the hot page out.
const MAX_CACHE_ENTRIES = 100;

const pageSchema = paginatedResponseSchema(PublicReleaseNoteSchema);
const cache = new Map<string, { page: UpstreamFeedPage; expiresAt: number }>();
let outage: { base: string; until: number } | undefined;

export const clearUpstreamFeedCache = () => {
  cache.clear();
  outage = undefined;
};

/** The operator-set upstream feed (WHATS_NEW_FEED_URL); blank means unset. */
export function getWhatsNewFeedUrl(): string | undefined {
  return process.env.WHATS_NEW_FEED_URL?.trim() || undefined;
}

const hostnameOf = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

// The app is served at app.<SERVER_DOMAIN> (infra/router.ts); previews leave SERVER_DOMAIN empty, so
// APP_URL (the router URL, set on the web lambda in infra/web.ts) is what names them.
const ownHostnames = (): string[] => {
  const domain = hostnameOf(process.env.SERVER_DOMAIN);
  return [domain, domain && `app.${domain}`, hostnameOf(process.env.APP_URL)].filter((host): host is string => !!host);
};

async function readCapped(response: Response): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type FetchResult = { page: UpstreamFeedPage | null; upstreamDown: boolean };

async function fetchPage(
  base: string,
  { limit, cursor }: { limit: number; cursor?: string },
  logger: Logger
): Promise<FetchResult> {
  const down: FetchResult = { page: null, upstreamDown: true };
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    logger.warn('[whats-new] WHATS_NEW_FEED_URL is not a valid URL');
    return down;
  }
  if (url.protocol !== 'https:') {
    logger.warn('[whats-new] WHATS_NEW_FEED_URL must use https');
    return down;
  }
  // Pointing the feed at this deployment would make each request fetch itself recursively.
  if (ownHostnames().includes(url.hostname.toLowerCase())) {
    logger.warn('[whats-new] WHATS_NEW_FEED_URL points at this deployment; ignoring it');
    return down;
  }
  url.searchParams.set('limit', String(limit));
  if (cursor !== undefined) url.searchParams.set('cursor', cursor);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Raced rather than relying on the signal alone: safeFetch resolves DNS for its SSRF check before the
  // signal reaches fetch, and a hung lookup would otherwise outlive the timeout.
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timed out'));
    }, TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([
      safeFetch(url.toString(), { headers: { accept: 'application/json' }, signal: controller.signal }),
      timeout,
    ]);
    if (!response.ok) {
      logger.warn('[whats-new] upstream feed returned a non-200 status', { status: response.status });
      // A 4xx (say, a bad cursor) is about this request, not the upstream, so it must not trip the outage.
      const requestError = response.status >= 400 && response.status < 500 && response.status !== 429;
      return { page: null, upstreamDown: !requestError };
    }
    const text = await Promise.race([readCapped(response), timeout]);
    if (text === null) {
      logger.warn('[whats-new] upstream feed body exceeded the size cap', { maxBytes: MAX_BODY_BYTES });
      return down;
    }
    const parsed = pageSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      logger.warn('[whats-new] upstream feed body did not match the public schema');
      return down;
    }
    return { page: parsed.data, upstreamDown: false };
  } catch (error) {
    logger.warn('[whats-new] upstream feed fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return down;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One page from the upstream feed, or null on any failure (unset, invalid, unreachable, oversize,
 * off-schema) so the caller can fall back to local notes. First pages are cached in memory per instance.
 */
export async function fetchUpstreamFeed(
  query: { limit: number; cursor?: string },
  logger: Logger
): Promise<UpstreamFeedPage | null> {
  const base = getWhatsNewFeedUrl();
  if (!base) return null;

  const now = Date.now();
  if (outage && outage.base === base && outage.until > now) return null;

  const key = query.cursor === undefined ? `${base}|${query.limit}` : undefined;
  const hit = key === undefined ? undefined : cache.get(key);
  if (hit && hit.expiresAt > now) return hit.page;

  const { page, upstreamDown } = await fetchPage(base, query, logger);
  if (upstreamDown) outage = { base, until: now + OUTAGE_TTL_MS };
  if (page && key !== undefined) {
    cache.delete(key);
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { page, expiresAt: now + OK_TTL_MS });
  }
  return page;
}
