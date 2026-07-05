import { IOrganization } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User } from '@bike4mind/database';

/**
 * Get the organization of a user
 */
const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id;

    const user = await User.findById(userId)
      .populate({
        path: 'organizationId',
        populate: {
          path: 'logo',
        },
      })
      .select('organizationId');
    const organization = (user?.organizationId as unknown as IOrganization) || null;

    return res.json(organization);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
