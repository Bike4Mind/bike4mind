// POST /api/organizations/:id/domain-join - join the org through a verified email domain claim
// 200 { joined } (false when already a member), 403 when the domain does not grant it, 409 when full.

import { ApiKeyScope } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { joinOrgViaDomain } from '@server/organizations/orgDomainClaims';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const { id: organizationId } = req.query;
    if (typeof organizationId !== 'string' || !organizationId) throw new BadRequestError('Invalid organization id');

    const { joined, organization } = await joinOrgViaDomain(req.user!.id, organizationId);
    return res.status(200).json({ joined, organizationId: organization.id, organizationName: organization.name });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
