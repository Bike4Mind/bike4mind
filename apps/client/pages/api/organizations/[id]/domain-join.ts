import { orgDomainPathIdSchema } from '@bike4mind/common';
// POST /api/organizations/:id/domain-join - join the org through a verified email domain claim
// 200 { joined } (false if already a member); 403 unverified email or non-granting domain; 409 full.

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { joinOrgViaDomain } from '@server/organizations/orgDomainClaims';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = orgDomainPathIdSchema.safeParse(req.query.id);
    if (!organizationId.success) throw new BadRequestError('Invalid organization id');

    const { joined, organization } = await joinOrgViaDomain(req.user!.id, organizationId.data);
    return res.status(200).json({ joined, organizationId: organization.id, organizationName: organization.name });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
