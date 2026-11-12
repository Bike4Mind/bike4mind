// GET  /api/organizations/:id/domains - list the org's domain claims
// POST /api/organizations/:id/domains - add a pending claim { domain }
// Owner, manager or platform admin (canAdministerOrganization); session routes, not public API contract.

import { addOrgDomainSchema, ApiKeyScope } from '@bike4mind/common';
import { orgDomainClaimRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { addDomainClaim, loadOrgForDomainAdmin, toOrgDomainClaimView } from '@server/organizations/orgDomainClaims';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const organizationIdFrom = (query: { id?: unknown }): string => {
  if (typeof query.id !== 'string' || !query.id) throw new BadRequestError('Invalid organization id');
  return query.id;
};

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organizationId = organizationIdFrom(req.query);
      await loadOrgForDomainAdmin(req.user!, organizationId);
      const claims = await orgDomainClaimRepository.listByOrganization(organizationId);
      return res.status(200).json({ claims: claims.map(toOrgDomainClaimView) });
    })
  )
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organizationId = organizationIdFrom(req.query);
      const organization = await loadOrgForDomainAdmin(req.user!, organizationId);
      // ZodError propagates to the central errorHandler (422).
      const { domain } = addOrgDomainSchema.parse(req.body ?? {});
      const claim = await addDomainClaim(organizationId, req.user!.id, domain);

      await recordAdminActionFromRequest(req, {
        action: 'org.domain.added',
        actorScope: 'organization',
        target: { kind: 'organization', id: organizationId, displayName: organization.name },
        summary: `added domain ${claim.domain}`,
      });

      return res.status(201).json({ claim: toOrgDomainClaimView(claim) });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
