import { z } from 'zod';
import {
  fromPublicReleaseNoteImage,
  fromPublicReleaseNoteVideo,
  getModalStillImageErrors,
  getModalVideoErrors,
  paginatedResponseSchema,
  PublicReleaseNoteSchema,
  type PublicReleaseNote,
  type PublicReleaseNoteImage,
  type PublicReleaseNoteVideo,
} from '@bike4mind/common';
import { isUpstreamMediaUrl } from '@server/releaseNotes/publicMedia';
import { deploymentMediaOrigins } from '@server/utils/deploymentMediaOrigins';
import { safeFetch } from '@bike4mind/server-utils/utils/ssrfProtection';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';

export type UpstreamFeedPage = { data: PublicReleaseNote[]; next_cursor: string | null };
type Logger = { warn: (message: string, meta?: Record<string, unknown>) => void };

const TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 1024 * 1024;
// Must stay in sync with the "about 31 minutes" figure in whatsNew.contract.ts (this is its +1 minute).
const OK_TTL_MS = 60_000;
// After an upstream-wide failure every request falls back without fetching for this long, so a dead
// upstream costs one timeout per window rather than one per request (or per distinct cursor).
const OUTAGE_TTL_MS = 30_000;
// Only first pages are cached, keyed by limit (1-100), so no request can push the hot page out.
const MAX_CACHE_ENTRIES = 100;

const pageSchema = paginatedResponseSchema(PublicReleaseNoteSchema);
const JSON_FEED_CURSOR_SCOPE = 'v1.whats-new.json-feed';
const jsonFeedCursorSchema = z.object({ published_at: z.string(), id: z.string().min(1) });
const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
// A JSON Feed 1.x document (https://jsonfeed.org), the format a marketing site's What's New page
// publishes. Only the fields a slide needs are read; an item without a date or text is skipped.
const jsonFeedSchema = z.object({
  version: z.string().startsWith('https://jsonfeed.org/version/'),
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string().optional(),
      summary: z.string().optional(),
      content_text: z.string().optional(),
      date_published: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
  ),
});
// The upstream's own API route, including when another path redirects to it.
const WHATS_NEW_API_PATH = '/api/v1/whats-new';
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

// A trailing dot names the same host, so it must not slip past the self-reference check.
const normalizeHost = (host: string): string => {
  let normalized = host.toLowerCase();
  while (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  return normalized;
};

const hostnameOf = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return normalizeHost(new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname);
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

const isOwnApiRoute = (url: URL): boolean =>
  ownHostnames().includes(normalizeHost(url.hostname)) && url.pathname.replace(/\/+$/, '') === WHATS_NEW_API_PATH;

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
  // A static feed on an own host is safe, but the app's own API route would recurse.
  if (isOwnApiRoute(url)) {
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
      safeFetch(
        url.toString(),
        { headers: { accept: 'application/json' }, signal: controller.signal },
        {
          assertRedirectAllowed: target => {
            if (isOwnApiRoute(target)) throw new Error("redirect points at this deployment's own feed route");
          },
        }
      ),
      timeout,
    ]);
    if (!response.ok) {
      logger.warn('[whats-new] upstream feed returned a non-200 status', { status: response.status });
      // Most 4xx (a bad cursor, a limit an older upstream rejects) are about this request and must not trip the
      // outage. A 401/403/404 on the first page means the feed URL itself is wrong or refused, so it does.
      const misconfigured = cursor === undefined && [401, 403, 404].includes(response.status);
      const requestError = !misconfigured && response.status >= 400 && response.status < 500 && response.status !== 429;
      return { page: null, upstreamDown: !requestError };
    }
    const text = await Promise.race([readCapped(response), timeout]);
    // An oversize, unparseable or off-schema page answered promptly and can follow from this request's limit or cursor
    // (a limit=100 page of long notes), so it must not trip the outage for every other query.
    if (text === null) {
      logger.warn('[whats-new] upstream feed body exceeded the size cap', { maxBytes: MAX_BODY_BYTES });
      return { page: null, upstreamDown: false };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const parsed = pageSchema.safeParse(body);
    if (parsed.success) return { page: vetMedia(parsed.data, base), upstreamDown: false };
    const feed = jsonFeedSchema.safeParse(body);
    if (feed.success) return { page: jsonFeedToPage(feed.data, limit, cursor), upstreamDown: false };
    logger.warn('[whats-new] upstream feed body matched neither the public schema nor JSON Feed');
    return { page: null, upstreamDown: false };
  } catch (error) {
    logger.warn('[whats-new] upstream feed fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return down;
  } finally {
    clearTimeout(timer);
  }
}

// Drops a video or image with any URL outside the deployment's media allowlist, which the CSP would block
// anyway, each independently. The upstream's own media route is allowed too (proxy.ts adds its origin to the CSP).
function vetMedia(page: UpstreamFeedPage, feedUrl: string): UpstreamFeedPage {
  const extraOrigins = deploymentMediaOrigins();
  const upstreamMediaUrls = (media: PublicReleaseNoteVideo | PublicReleaseNoteImage) =>
    new Set(Object.values(media).filter((url): url is string => !!url && isUpstreamMediaUrl(url, feedUrl)));
  return {
    ...page,
    data: page.data.map(note => {
      let vetted = note;
      if (note.video) {
        const policy = { extraOrigins, allowedUrls: upstreamMediaUrls(note.video) };
        if (Object.keys(getModalVideoErrors(fromPublicReleaseNoteVideo(note.video), policy)).length > 0) {
          vetted = { ...vetted, video: null };
        }
      }
      if (note.image) {
        const policy = { extraOrigins, allowedUrls: upstreamMediaUrls(note.image) };
        if (Object.keys(getModalStillImageErrors(fromPublicReleaseNoteImage(note.image), policy)).length > 0) {
          vetted = { ...vetted, image: null };
        }
      }
      return vetted;
    }),
  };
}

/** A page of JSON Feed items ordered by publish date and id, with a stable cursor across new entries. */
export function jsonFeedToPage(feed: z.infer<typeof jsonFeedSchema>, limit: number, cursor?: string): UpstreamFeedPage {
  const notes: PublicReleaseNote[] = [];
  for (const item of feed.items) {
    const publishedAt = item.date_published ? new Date(item.date_published) : undefined;
    const headline = item.title?.trim() ?? '';
    const summary = item.content_text?.trim() || item.summary?.trim() || '';
    if (!publishedAt || Number.isNaN(publishedAt.getTime()) || (!headline && !summary)) continue;
    notes.push({
      id: item.id,
      release_tag: item.tags?.[0]?.trim() || 'Update',
      headline,
      summary,
      published_at: publishedAt.toISOString(),
      items: [],
    });
  }
  notes.sort((a, b) => b.published_at.localeCompare(a.published_at) || compareIds(a.id, b.id));

  let remaining = notes;
  if (cursor !== undefined) {
    try {
      const decoded: unknown = JSON.parse(decodeCursor(cursor, JSON_FEED_CURSOR_SCOPE));
      const position = jsonFeedCursorSchema.parse(decoded);
      const at = new Date(position.published_at);
      if (Number.isNaN(at.getTime()) || at.toISOString() !== position.published_at) {
        return { data: [], next_cursor: null };
      }
      remaining = notes.filter(
        note =>
          note.published_at < position.published_at ||
          (note.published_at === position.published_at && note.id > position.id)
      );
    } catch {
      // A cursor from a previous upstream cannot be resumed after the source changes.
      return { data: [], next_cursor: null };
    }
  }
  const data = remaining.slice(0, limit);
  const last = data[data.length - 1];
  const next_cursor =
    remaining.length > limit && last
      ? encodeCursor(JSON_FEED_CURSOR_SCOPE, JSON.stringify({ published_at: last.published_at, id: last.id }))
      : null;
  return { data, next_cursor };
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
  const key = query.cursor === undefined ? `${base}|${query.limit}` : undefined;
  const hit = key === undefined ? undefined : cache.get(key);
  if (hit && hit.expiresAt > now) return hit.page;
  if (outage && outage.base === base && outage.until > now) return null;

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
