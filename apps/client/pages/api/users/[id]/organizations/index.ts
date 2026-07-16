import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { organizationRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { toSafeOrganizations } from '@bike4mind/common';

/**
 * List the organizations the caller owns or belongs to.
 */
const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const organizations = await organizationService.listOwn(req.user, {
      db: {
        organizations: organizationRepository,
      },
    });

    // listOwn returns orgs the caller is merely a member of too, so strip billing
    // identifiers from any org the caller does not own (per-item owner check).
    return res.json(toSafeOrganizations(organizations, { userId: req.user.id, isAdmin: req.user.isAdmin }));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
