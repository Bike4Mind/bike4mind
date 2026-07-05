import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { organizationRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';

/**
 * Get the organization of a user
 */
const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const organizations = await organizationService.listOwn(req.user, {
      db: {
        organizations: organizationRepository,
      },
    });

    return res.json(organizations);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
