import { fabFileRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { Request } from 'express';

const handler = baseApi().get(async (req: Request<unknown, unknown, unknown, { fabFileId?: string }>, res) => {
  if (!req.query.fabFileId) throw new NotFoundError('Fab file not found');

  // Object-level guard: the id comes straight off the query, so gate access before returning any
  // field - otherwise any authenticated caller could read another user's file name. Throws
  // NotFoundError on missing-or-not-yours.
  const fabFile = await fabFilesService.assertFabFileAccessById(req.user, req.query.fabFileId, {
    db: { fabFiles: fabFileRepository },
  });

  return res.json({ name: fabFile.fileName });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
