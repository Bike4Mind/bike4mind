// PATCH/DELETE /api/spaces/:id/domains/:claimId - set { policy: 'off' | 'suggest' }, or remove the claim.
// Owner and Space admins only. Claims resolve only within :id.

import { orgDomainPathIdSchema, updateSpaceDomainPolicySchema } from '@bike4mind/common';
import { orgDomainClaimRepository } from '@bike4mind/database';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { toOrgDomainClaimView, updateSpaceDomainClaimPolicy } from '@server/organizations/orgDomainClaims';
import { loadManagedSpace } from '@server/spaces/spaceAccess';

type Query = { id?: string; claimId?: string };

const claimIdFrom = (query: Query): string => {
  const claimId = orgDomainPathIdSchema.safeParse(query.claimId);
  if (!claimId.success) throw new NotFoundError('Domain claim not found');
  return claimId.data;
};

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .patch(
    asyncHandler<{}, unknown, unknown, Query>(async (req, res) => {
      const space = await loadManagedSpace(req.user!, req.query.id);
      const update = updateSpaceDomainPolicySchema.parse(req.body ?? {});
      const { before, after } = await updateSpaceDomainClaimPolicy(space.id, claimIdFrom(req.query), update);
      req.logger.info(
        `[SPACE_DOMAIN] space.domain.policy_updated space=${space.id} domain=${after.domain} ${before.policy}->${after.policy}`
      );
      res.status(200).json({ claim: toOrgDomainClaimView(after) });
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, Query>(async (req, res) => {
      const space = await loadManagedSpace(req.user!, req.query.id);
      const claimId = claimIdFrom(req.query);
      const claim = await orgDomainClaimRepository.findByIdForSpace(claimId, space.id);
      if (!claim || !(await orgDomainClaimRepository.deleteForSpace(claimId, space.id))) {
        throw new NotFoundError('Domain claim not found');
      }
      req.logger.info(`[SPACE_DOMAIN] space.domain.removed space=${space.id} domain=${claim.domain}`);
      res.status(204).end();
    })
  );

export default handler;
