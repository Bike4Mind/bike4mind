import { orgDomainPathIdSchema } from '@bike4mind/common';
// POST /api/organizations/:id/domains/:claimId/verify - check the claim's DNS TXT record
// A lookup miss is 200 { verified: false, reason }, not an error; losing a verify race is 409.

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { loadOrgForDomainAdmin, toOrgDomainClaimView, verifyDomainClaim } from '@server/organizations/orgDomainClaims';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

// Each call can make up to two outbound DNS lookups, so it is capped per user across all claims.
export const VERIFY_RATE_LIMIT = { limit: 10, windowMs: 60 * 1000, bucket: 'organizations/domains/verify' } as const;

const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit(VERIFY_RATE_LIMIT))
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string; claimId?: string }>(async (req, res) => {
      const organizationId = orgDomainPathIdSchema.safeParse(req.query.id);
      const claimId = orgDomainPathIdSchema.safeParse(req.query.claimId);
      if (!organizationId.success) throw new BadRequestError('Invalid organization id');
      if (!claimId.success) throw new BadRequestError('Invalid domain claim id');

      const organization = await loadOrgForDomainAdmin(req.user!, organizationId.data);
      const result = await verifyDomainClaim(organization.id, claimId.data);
      if (!result.verified) return res.status(200).json({ verified: false, reason: result.reason });

      await recordAdminActionFromRequest(req, {
        action: 'org.domain.verified',
        actorScope: 'organization',
        target: { kind: 'organization', id: organization.id, displayName: organization.name },
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
