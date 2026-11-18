// GET/POST /api/spaces/:id/domains - list and add the Space's domain claims. Owner and Space admins only.

import { addOrgDomainSchema } from '@bike4mind/common';
import { orgDomainClaimRepository } from '@bike4mind/database';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { addSpaceDomainClaim, toOrgDomainClaimView } from '@server/organizations/orgDomainClaims';
import { loadManagedSpace } from '@server/spaces/spaceAccess';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const space = await loadManagedSpace(req.user!, req.query.id);
      const claims = await orgDomainClaimRepository.listBySpace(space.id);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ claims: claims.map(toOrgDomainClaimView) });
    })
  )
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const space = await loadManagedSpace(req.user!, req.query.id);
      const { domain } = addOrgDomainSchema.parse(req.body ?? {});
      const claim = await addSpaceDomainClaim(space.id, req.user!.id, domain);
      req.logger.info(`[SPACE_DOMAIN] space.domain.added space=${space.id} domain=${claim.domain}`);
      res.status(201).json({ claim: toOrgDomainClaimView(claim) });
    })
  );

export default handler;
