// GET /api/groups
// Index route to get all visible groups for the current user

import { Group } from '@bike4mind/database/social';
import { organizationGroupResponseSchema } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { respond } from '@server/utils/respond';
import { z } from 'zod';

const groupsResponseSchema = z.object({ groups: z.array(organizationGroupResponseSchema) });

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const groups = !!req.user?.groups?.length ? await Group.find({ _id: { $in: req.user.groups } }) : [];
    return respond(res, groupsResponseSchema, { groups });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
