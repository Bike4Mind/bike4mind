// PUT /api/organizations/:id/member-credit-budget
// Set or clear the org's default monthly per-member credit budget. Billing owner, appointed org
// admin, or platform admin (organizationService.canManageMemberCreditBudgets).

import { ApiKeyScope, toSafeOrganization } from '@bike4mind/common';
import { organizationService } from '@bike4mind/services';
import { organizationRepository } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';

const bodySchema = z.object({ maxCreditsPerMember: z.number().nullable() });

// `admin:*` only: a scope-less baseApi() admits any valid API key, and a spending limit on the org
// pool is not something an ordinary integration key should be able to lift. Session callers are
// unaffected - the scope gate no-ops without `req.apiKeyInfo`.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    if (typeof organizationId !== 'string' || !organizationId) {
      throw new BadRequestError('Invalid organization id');
    }

    const { maxCreditsPerMember } = bodySchema.parse(req.body);
    const change = await organizationService.setMemberCreditDefault(
      req.user!,
      { organizationId, maxCreditsPerMember },
      { db: { organizations: organizationRepository } }
    );

    await logAuditEvent(
      {
        userId: req.user!.id,
        action: AdminOrgAuditEvents.ORG_MEMBER_CREDIT_BUDGET_UPDATED,
        ip: req.ip,
        userAgent: req.headers['user-agent'] || 'unknown',
        metadata: { organizationId, previous: change.previous, current: change.current },
      },
      req.logger
    );

    return res.json(toSafeOrganization(change.organization, { userId: req.user!.id, isAdmin: req.user!.isAdmin }));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
