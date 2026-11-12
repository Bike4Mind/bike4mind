// POST /api/organizations/:id/domains/:claimId/verify - check the claim's DNS TXT record
// A lookup miss is 200 { verified: false, reason }, not an error; losing a verify race is 409.

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { loadOrgForDomainAdmin, toOrgDomainClaimView, verifyDomainClaim } from '@server/organizations/orgDomainClaims';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id?: string; claimId?: string }>(async (req, res) => {
    const { id: organizationId, claimId } = req.query;
    if (typeof organizationId !== 'string' || !organizationId) throw new BadRequestError('Invalid organization id');
    if (typeof claimId !== 'string' || !claimId) throw new BadRequestError('Invalid domain claim id');

    const organization = await loadOrgForDomainAdmin(req.user!, organizationId);
    const result = await verifyDomainClaim(organizationId, claimId);
    if (!result.verified) return res.status(200).json({ verified: false, reason: result.reason });

    await recordAdminActionFromRequest(req, {
      action: 'org.domain.verified',
      actorScope: 'organization',
      target: { kind: 'organization', id: organizationId, displayName: organization.name },
      summary: `verified domain ${result.claim.domain}`,
    });

    return res.status(200).json({ verified: true, claim: toOrgDomainClaimView(result.claim) });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
