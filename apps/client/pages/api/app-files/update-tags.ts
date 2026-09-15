import { AppFileEvents, IAppFile } from '@bike4mind/common';
import { AppFile } from '@bike4mind/database/content';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { z } from 'zod';

const AppFileUpdateTagsRequestInput = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  description: z.string().optional(),
});

const handler = baseApi().patch(
  asyncHandler<unknown, IAppFile>(async (req, res) => {
    const userId = req.user?.id;
    const data = AppFileUpdateTagsRequestInput.parse(req.body);

    // Ownership check: scope the update filter to the requesting user so an
    // attacker cannot modify tags/description on another user's file. Both
    // "not found" and "not yours" return NotFoundError to avoid enumeration.
    const updatedAppFile = await AppFile.findOneAndUpdate(
      { _id: data.id, userId },
      { tags: data.tags, description: data.description },
      { new: true }
    );
    if (updatedAppFile === null) throw new NotFoundError('App file not found');

    await logEvent(
      { userId, type: AppFileEvents.UPDATE_APP_FILE_TAGS, metadata: { id: data.id, tags: data.tags } },
      { ability: req.ability }
    );

    return res.json(updatedAppFile);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
