// POST /api/spaces/:id/domains/:claimId/verify - check the claim's DNS TXT record. Owner and Space admins only.
// A lookup miss is 200 { verified: false, reason }, not an error; losing a verify race is 409.

import { orgDomainPathIdSchema } from '@bike4mind/common';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { toOrgDomainClaimView, verifySpaceDomainClaim } from '@server/organizations/orgDomainClaims';
import { loadManagedSpace } from '@server/spaces/spaceAccess';

// Each call can make up to two outbound DNS lookups, so it is capped per user across all claims.
export const VERIFY_RATE_LIMIT = { limit: 10, windowMs: 60 * 1000, bucket: 'spaces/domains/verify' } as const;

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .use(rateLimit(VERIFY_RATE_LIMIT))
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string; claimId?: string }>(async (req, res) => {
      const space = await loadManagedSpace(req.user!, req.query.id);
      const claimId = orgDomainPathIdSchema.safeParse(req.query.claimId);
      if (!claimId.success) throw new NotFoundError('Domain claim not found');

      const result = await verifySpaceDomainClaim(space.id, claimId.data);
      if (!result.verified) return res.status(200).json({ verified: false, reason: result.reason });

      req.logger.info(`[SPACE_DOMAIN] space.domain.verified space=${space.id} domain=${result.claim.domain}`);
      return res.status(200).json({ verified: true, claim: toOrgDomainClaimView(result.claim) });
    })
  );

export default handler;
