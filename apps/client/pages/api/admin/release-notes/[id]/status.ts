import { z } from 'zod';
import { releaseNoteRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import {
  findDeniedInNote,
  loadDenylistOrThrow,
  noteOrThrow,
  toAdminReleaseNote,
} from '@bike4mind/server-utils/releaseNotes/adminReleaseNotes';

const ActionSchema = z.object({ action: z.enum(['hide', 'unhide', 'publishNow']) }).strict();

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query;
  if (!isValidObjectId(id)) throw new BadRequestError('Invalid release note id');

  const parsed = ActionSchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError('action must be one of hide, unhide, publishNow');

  const { action } = parsed.data;
  if (action !== 'hide') {
    // The denylist may have grown since this note was generated or last edited.
    const denylist = await loadDenylistOrThrow(req.logger);
    const current = await releaseNoteRepository.findById(id);
    if (!current) throw new NotFoundError('Release note not found');
    const term = findDeniedInNote(current, denylist);
    if (term) throw new BadRequestError(`This release note mentions "${term}"; edit it before it goes live`);
  }
  const result =
    action === 'hide'
      ? await releaseNoteRepository.hide(id)
      : action === 'unhide'
        ? await releaseNoteRepository.unhide(id)
        : await releaseNoteRepository.publishNow(id);
  const note = noteOrThrow(result);
  await recordAdminActionFromRequest(req, {
    action: 'settings.release_note.status_changed',
    target: { kind: 'settings', id, displayName: `release note ${note.releaseTag}` },
    summary: `${action} release note ${note.releaseTag}`,
    details: { releaseTag: note.releaseTag, action },
  });
  return res.json(toAdminReleaseNote(note));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
