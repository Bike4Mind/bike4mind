// GET /api/groups
// Index route to get all visible groups for the current user

import { Group } from '@bike4mind/database/social';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const groups = !!req.user?.groups?.length ? await Group.find({ _id: { $in: req.user.groups } }) : [];
    return res.status(200).json({ groups });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
