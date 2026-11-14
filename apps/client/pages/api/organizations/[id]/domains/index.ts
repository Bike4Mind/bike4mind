// GET  /api/organizations/:id/domains - list the org's domain claims
// POST /api/organizations/:id/domains - add a pending claim { domain }
// Org `manageMembers` permission, or platform admin; session routes, not public API contract.

import { addOrgDomainSchema, orgDomainPathIdSchema } from '@bike4mind/common';
import { orgDomainClaimRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { addDomainClaim, loadOrgForDomainAdmin, toOrgDomainClaimView } from '@server/organizations/orgDomainClaims';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const organizationIdFrom = (query: { id?: unknown }): string => {
  const parsed = orgDomainPathIdSchema.safeParse(query.id);
  if (!parsed.success) throw new BadRequestError('Invalid organization id');
  return parsed.data;
};

const handler = baseApi({ auth: 'jwtOnly' })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organizationId = organizationIdFrom(req.query);
      const organization = await loadOrgForDomainAdmin(req.user!, organizationId);
      const claims = await orgDomainClaimRepository.listByOrganization(organization.id);
      return res.status(200).json({ claims: claims.map(toOrgDomainClaimView) });
    })
  )
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organizationId = organizationIdFrom(req.query);
      const organization = await loadOrgForDomainAdmin(req.user!, organizationId);
      // ZodError propagates to the central errorHandler (422).
      const { domain } = addOrgDomainSchema.parse(req.body ?? {});
      const claim = await addDomainClaim(organization.id, req.user!.id, domain);

      await recordAdminActionFromRequest(req, {
        action: 'org.domain.added',
        actorScope: 'organization',
        target: { kind: 'organization', id: organization.id, displayName: organization.name },
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
