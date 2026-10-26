import { z } from 'zod';
import { releaseNoteRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';
import { ForbiddenError, UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { loadReleaseNotesConfig, toAdminReleaseNote } from '@bike4mind/server-utils/releaseNotes/adminReleaseNotes';
import { canAdministerReleaseNotes, isReleaseNotesWriteOnlyKey } from '@server/releaseNotes/releaseNotesWriteOnlyKey';

const QuerySchema = z.object({
  status: z.enum(['scheduled', 'published', 'hidden']).default('scheduled'),
  cursor: z.string().min(1).optional(),
  tag: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const api = baseApi({ requiredScopes: [ApiKeyScope.ADMIN, ApiKeyScope.RELEASE_NOTES_WRITE] });

const handler = api.get(async (req, res) => {
  // The job key holds release-notes:write and no admin scope, so apiKeyAuth withholds the owner's admin
  // role on req.user; the narrow form that key gets is enforced below.
  if (!canAdministerReleaseNotes(req)) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const query = QuerySchema.safeParse(req.query);
  if (!query.success) {
    throw new UnprocessableEntityError(
      query.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    );
  }
  const { status, cursor, limit, tag } = query.data;
  // The release-video job looks up the note of one release; browsing the admin list stays admin:*.
  if (tag === undefined && isReleaseNotesWriteOnlyKey(req)) {
    throw new ForbiddenError(`${ApiKeyScope.RELEASE_NOTES_WRITE} may only look a note up by tag`);
  }

  if (tag !== undefined) {
    if (cursor !== undefined) throw new UnprocessableEntityError('tag: cannot be combined with cursor');
    const { config: tagConfig } = await loadReleaseNotesConfig(req.logger);
    const found = await releaseNoteRepository.findOne({ releaseTag: tag });
    const tagNow = new Date();
    return res.json({
      data: found ? [toAdminReleaseNote(found, tagNow, tagConfig.denylist)] : [],
      next_cursor: null,
    });
  }
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
