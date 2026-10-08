import { paginatedResponseSchema, PublicReleaseNoteSchema, type PublicReleaseNote } from '@bike4mind/common';
import { safeFetch } from '@server/utils/ssrfProtection';

export type UpstreamFeedPage = { data: PublicReleaseNote[]; next_cursor: string | null };
type Logger = { warn: (message: string, meta?: Record<string, unknown>) => void };

const TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 256 * 1024;
const OK_TTL_MS = 60_000;
// A failed fetch is remembered too, so a dead upstream costs one timeout per window, not one per request.
const FAILED_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 50;

const pageSchema = paginatedResponseSchema(PublicReleaseNoteSchema);
const cache = new Map<string, { page: UpstreamFeedPage | null; expiresAt: number }>();

export const clearUpstreamFeedCache = () => cache.clear();

/** The operator-set upstream feed (WHATS_NEW_FEED_URL); blank means unset. */
export function getWhatsNewFeedUrl(): string | undefined {
  return process.env.WHATS_NEW_FEED_URL?.trim() || undefined;
}

// SERVER_DOMAIN may be a bare host or a full origin.
const ownHostname = (): string | undefined => {
  const domain = process.env.SERVER_DOMAIN?.trim();
  if (!domain) return undefined;
  try {
    return new URL(domain.includes('://') ? domain : `https://${domain}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
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

async function fetchPage(
  base: string,
  { limit, cursor }: { limit: number; cursor?: string },
  logger: Logger
): Promise<UpstreamFeedPage | null> {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    logger.warn('[whats-new] WHATS_NEW_FEED_URL is not a valid URL');
    return null;
  }
  if (url.protocol !== 'https:') {
    logger.warn('[whats-new] WHATS_NEW_FEED_URL must use https');
    return null;
  }
  // Pointing the feed at this deployment would make each request fetch itself recursively.
  if (url.hostname.toLowerCase() === ownHostname()) {
    logger.warn('[whats-new] WHATS_NEW_FEED_URL points at this deployment; ignoring it');
    return null;
  }
  url.searchParams.set('limit', String(limit));
  if (cursor !== undefined) url.searchParams.set('cursor', cursor);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await safeFetch(url.toString(), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn('[whats-new] upstream feed returned a non-200 status', { status: response.status });
      return null;
    }
    const text = await readCapped(response);
    if (text === null) {
      logger.warn('[whats-new] upstream feed body exceeded the size cap', { maxBytes: MAX_BODY_BYTES });
      return null;
    }
    const parsed = pageSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      logger.warn('[whats-new] upstream feed body did not match the public schema');
      return null;
    }
    return parsed.data;
  } catch (error) {
    logger.warn('[whats-new] upstream feed fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One page from the upstream feed, or null on any failure (unset, invalid, unreachable, oversize,
 * off-schema) so the caller can fall back to local notes. Results are cached in memory per instance.
 */
export async function fetchUpstreamFeed(
  query: { limit: number; cursor?: string },
  logger: Logger
): Promise<UpstreamFeedPage | null> {
  const base = getWhatsNewFeedUrl();
  if (!base) return null;

  const key = `${base}|${query.limit}|${query.cursor ?? ''}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.page;

  const page = await fetchPage(base, query, logger);
  cache.delete(key);
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { page, expiresAt: now + (page ? OK_TTL_MS : FAILED_TTL_MS) });
  return page;
}
