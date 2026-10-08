import { adminSettingsRepository, releaseNoteRepository, type IReleaseNoteDocument } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { listWhatsNewContract, parseReleaseNotesConfig, type PublicReleaseNote } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@server/middlewares/rateLimit';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';

const CURSOR_SCOPE = 'v1.whats-new';
const SETTING_NAME = 'releaseNotesConfig';
// Seconds. Bounds how long a hidden note stays visible at the CDN (s-maxage + stale-while-revalidate).
const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=600';

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
  const after = cursor === undefined ? undefined : decodeTimeIdCursor(cursor, CURSOR_SCOPE);

  const settings = await getSettingsByNames(
    [SETTING_NAME],
    { adminSettings: adminSettingsRepository },
    { logger: req.logger }
  );
  const notesConfig = parseReleaseNotesConfig(settings[SETTING_NAME]);
  if (!notesConfig.success) {
    req.logger.warn(`[whats-new] ${SETTING_NAME} is malformed; serving an empty list`, {
      issues: notesConfig.error.issues,
    });
  }

  let body: { data: PublicReleaseNote[]; next_cursor: string | null } = { data: [], next_cursor: null };
  if (notesConfig.success && notesConfig.data.enabled) {
    const { items, hasMore } = await releaseNoteRepository.listPublished({
      now: new Date(),
      after: after && { publishAt: after.at, id: after.id },
      limit,
    });
    const last = items[items.length - 1];
    body = {
      data: items.map(toPublicReleaseNote),
      next_cursor: hasMore ? encodeTimeIdCursor(CURSOR_SCOPE, { at: last.publishAt, id: last.id }) : null,
    };
  }

  // Set only here, so error responses are never cached.
  res.setHeader('Cache-Control', CACHE_CONTROL);
  return res.json(body);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
