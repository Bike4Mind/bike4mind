import { IOrganization } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';

/**
 * Get the organization of a user
 */
const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id;

    // The organization document carries billing and member data, so only the
    // user themselves or an admin may read their org via this route.
    if (userId !== req.user.id && !req.user.isAdmin) {
      throw new ForbiddenError('Not authorized to view this organization');
    }

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
