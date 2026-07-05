import { FabFile } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { Request } from 'express';

const handler = baseApi().get(async (req: Request<unknown, unknown, unknown, { fabFileId?: string }>, res) => {
  if (!req.query.fabFileId) throw new NotFoundError('Fab file not found');
  const fabFile = await FabFile.findOne({ _id: req.query.fabFileId });

  if (!fabFile) throw new NotFoundError('Fab file not found');

  return res.json({ name: fabFile.fileName });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
