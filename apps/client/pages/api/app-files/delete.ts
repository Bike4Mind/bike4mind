import { logEvent } from '@server/utils/analyticsLog';
import { AppFile } from '@bike4mind/database/content';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

import { NotFoundError } from '@server/utils/errors';
import { z } from 'zod';
import { AppFileEvents } from '@bike4mind/common';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { Resource } from 'sst';

const AppFileDeleteRequestInput = z.object({
  id: z.string(),
});

const handler = baseApi().delete(
  asyncHandler<unknown, { id: string }>(async (req, res) => {
    const userId = req.user?.id;
    const data = AppFileDeleteRequestInput.parse(req.body);

    // Ownership check: scope lookup to the requesting user so an attacker
    // cannot delete (or probe for) files belonging to other users. Both
    // "not found" and "not yours" return NotFoundError to avoid enumeration.
    const file = await AppFile.findOne({ _id: data.id, userId });
    if (!file) throw new NotFoundError('File not found');

    await AppFile.deleteOne({ _id: file._id, userId });

    const storage = new S3Storage(Resource.appFilesBucket.name);
    await storage.delete(file.path);

    await logEvent(
      { userId, type: AppFileEvents.DELETE_APP_FILE, metadata: { id: data.id } },
      { ability: req.ability }
    );

    return res.json({ id: data.id });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
