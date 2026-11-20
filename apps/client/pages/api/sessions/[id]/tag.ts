import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { queueSessionTags } from '@server/sessions/queueSessionTags';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const { queued, failed } = await queueSessionTags(req, [req.query.id]);
    if (failed.length > 0) throw new Error('Could not queue tagging');
    if (queued.length === 0) throw new Error('Cannot update session');

    return res.json({ message: 'Tagging job queued', requestId: queued[0].requestId });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
