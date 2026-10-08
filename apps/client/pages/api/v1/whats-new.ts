import { releaseNoteRepository, type IReleaseNoteDocument } from '@bike4mind/database';
import { listWhatsNewContract, type PublicReleaseNote } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@server/middlewares/rateLimit';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';
import { findDeniedInNote, loadReleaseNotesConfig } from '@server/releaseNotes/adminReleaseNotes';
import { fetchUpstreamFeed, getWhatsNewFeedUrl } from '@server/releaseNotes/upstreamFeed';

const CURSOR_SCOPE = 'v1.whats-new';
// Seconds. Bounds how long a hidden note stays visible at the CDN (s-maxage + stale-while-revalidate).
const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=600';
const FALLBACK_CACHE_CONTROL = 'public, s-maxage=30, stale-while-revalidate=30';

const toPublicReleaseNote = (note: IReleaseNoteDocument): PublicReleaseNote => ({
  id: note.id,
  release_tag: note.releaseTag,
  headline: note.headline,
  summary: note.summary,
  published_at: note.publishAt.toISOString(),
  items: note.items.map(({ category, text, importance }) => ({ category, text, importance })),
});

const handler = nextRouteForContract(listWhatsNewContract, {
  // No user on a public route, so the limiter keys on the client IP.
  rateLimit: rateLimit({ limit: 60, windowMs: 60_000, bucket: 'GET /api/v1/whats-new' }),
}).get(async (req, res) => {
  const { limit, cursor } = req.validatedQuery;
  // A malformed config is served as disabled (loadReleaseNotesConfig logs it).
  const { config, malformed } = await loadReleaseNotesConfig(req.logger);
  const withholdDenied = (note: Parameters<typeof findDeniedInNote>[0] & { id: string }) => {
    const term = findDeniedInNote(note, config.denylist);
    if (term) req.logger.warn('[whats-new] withholding a release note that matches the denylist', { id: note.id });
    return !term;
  };

  // Setting WHATS_NEW_FEED_URL is the operator's opt-in, so the upstream is served even while local
  // release notes are disabled. Its cursor is passed through untouched.
  const usingUpstream = getWhatsNewFeedUrl() !== undefined;
  if (usingUpstream) {
    const upstream = await fetchUpstreamFeed({ limit, cursor }, req.logger);
    if (upstream) {
      res.setHeader('Cache-Control', CACHE_CONTROL);
      return res.json({ data: upstream.data.filter(withholdDenied), next_cursor: upstream.next_cursor });
    }
  }

  let after: ReturnType<typeof decodeTimeIdCursor> | undefined;
  if (cursor !== undefined) {
    try {
      after = decodeTimeIdCursor(cursor, CURSOR_SCOPE);
    } catch (error) {
      // An upstream-issued cursor means nothing to the local fallback, so it ends the list instead of erroring.
      if (!usingUpstream) throw error;
      res.setHeader('Cache-Control', FALLBACK_CACHE_CONTROL);
      return res.json({ data: [], next_cursor: null });
    }
  }

  let body: { data: PublicReleaseNote[]; next_cursor: string | null } = { data: [], next_cursor: null };
  if (!malformed && config.enabled) {
    const { items, hasMore } = await releaseNoteRepository.listPublished({
      now: new Date(),
      after: after && { publishAt: after.at, id: after.id },
      limit,
    });
    // The denylist can grow after a note was generated, and a scheduled note goes live without passing the
    // admin routes' check, so it is rechecked on read. A page can come back short; the cursor still
    // advances past the last row read, withheld or not.
    const shown = items.filter(withholdDenied);
    const last = items[items.length - 1];
    body = {
      data: shown.map(toPublicReleaseNote),
      next_cursor: hasMore ? encodeTimeIdCursor(CURSOR_SCOPE, { at: last.publishAt, id: last.id }) : null,
    };
  }

  // Set only on success, so error responses are never cached. A fallback page is cached briefly so the
  // upstream is retried soon after it recovers.
  res.setHeader('Cache-Control', usingUpstream ? FALLBACK_CACHE_CONTROL : CACHE_CONTROL);
  return res.json(body);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
