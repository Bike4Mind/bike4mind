// PATCH  /api/organizations/:id/domains/:claimId - set { policy }
// DELETE /api/organizations/:id/domains/:claimId - remove the claim
// Owner, manager or platform admin (canAdministerOrganization). Claims resolve only within :id.

import { updateOrgDomainPolicySchema } from '@bike4mind/common';
import { orgDomainClaimRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  loadOrgForDomainAdmin,
  toOrgDomainClaimView,
  updateDomainClaimPolicy,
} from '@server/organizations/orgDomainClaims';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';

type Query = { id?: string; claimId?: string };

const idsFrom = (query: Query) => {
  if (typeof query.id !== 'string' || !query.id) throw new BadRequestError('Invalid organization id');
  if (typeof query.claimId !== 'string' || !query.claimId) throw new BadRequestError('Invalid domain claim id');
  return { organizationId: query.id, claimId: query.claimId };
};

const handler = baseApi({ auth: 'jwtOnly' })
  .patch(
    asyncHandler<{}, unknown, unknown, Query>(async (req, res) => {
      const { organizationId, claimId } = idsFrom(req.query);
      const organization = await loadOrgForDomainAdmin(req.user!, organizationId);
      const update = updateOrgDomainPolicySchema.parse(req.body ?? {});
      const { before, after } = await updateDomainClaimPolicy(organizationId, claimId, update);

      await recordAdminActionFromRequest(req, {
        action: 'org.domain.policy_updated',
        actorScope: 'organization',
        target: { kind: 'organization', id: organizationId, displayName: organization.name },
        summary: `updated join policy for ${after.domain}`,
        changes: [{ field: 'policy', before: before.policy, after: after.policy }],
      });

      return res.status(200).json({ claim: toOrgDomainClaimView(after) });
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, Query>(async (req, res) => {
      const { organizationId, claimId } = idsFrom(req.query);
      const organization = await loadOrgForDomainAdmin(req.user!, organizationId);
      const claim = await orgDomainClaimRepository.findByIdForOrg(claimId, organizationId);
      if (!claim || !(await orgDomainClaimRepository.deleteForOrg(claimId, organizationId))) {
        throw new NotFoundError('Domain claim not found');
      }

      await recordAdminActionFromRequest(req, {
        action: 'org.domain.removed',
        actorScope: 'organization',
        target: { kind: 'organization', id: organizationId, displayName: organization.name },
        summary: `removed domain ${claim.domain}`,
      });

      return res.status(204).end();
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
