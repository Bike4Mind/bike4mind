import { z } from 'zod';
import { releaseNoteRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { isValidObjectId } from '@server/utils/objectId';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { noteOrThrow, toAdminReleaseNote } from '@server/releaseNotes/adminReleaseNotes';

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
  const result =
    action === 'hide'
      ? await releaseNoteRepository.hide(id)
      : action === 'unhide'
        ? await releaseNoteRepository.unhide(id)
        : await releaseNoteRepository.publishNow(id);
  return res.json(toAdminReleaseNote(noteOrThrow(result)));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
