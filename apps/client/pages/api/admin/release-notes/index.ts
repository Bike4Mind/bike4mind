import { z } from 'zod';
import { releaseNoteRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';
import { ForbiddenError, UnprocessableEntityError } from '@server/utils/errors';
import { loadReleaseNotesConfig, toAdminReleaseNote } from '@server/releaseNotes/adminReleaseNotes';

const QuerySchema = z.object({
  status: z.enum(['scheduled', 'published', 'hidden']).default('scheduled'),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const query = QuerySchema.safeParse(req.query);
  if (!query.success) {
    throw new UnprocessableEntityError(
      query.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    );
  }
  const { status, cursor, limit } = query.data;
  // Scoped per status, so a cursor from one filter is refused by another.
  const cursorScope = `admin.release-notes.${status}`;
  const after = cursor === undefined ? undefined : decodeTimeIdCursor(cursor, cursorScope);

  const { config } = await loadReleaseNotesConfig(req.logger);
  const now = new Date();
  const { items, hasMore } = await releaseNoteRepository.adminList({
    status,
    now,
    after: after && { publishAt: after.at, id: after.id },
    limit,
  });
  const last = items[items.length - 1];
  return res.json({
    data: items.map(note => toAdminReleaseNote(note, now, config.denylist)),
    next_cursor: hasMore ? encodeTimeIdCursor(cursorScope, { at: last.publishAt, id: last.id }) : null,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
