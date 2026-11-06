import { ApiKeyScope } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { requestApproval } from '@server/admin/approvals/service';
import { creditGrantNeedsApproval } from '@server/admin/creditGrants/gate';
import { TopUpSchema, topUpOrg } from '@server/admin/creditGrants/topUpOrg';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { parseAdminActionReason } from '@server/utils/adminAudit';
import type { Request } from 'express';

interface RequestQuery {
  id: string;
}

// requiredScopes gates the API-key path only: apiKeyAuth 403s an under-scoped key
// before req.user is set, so a key issued for a narrow integration can't grant
// org credits just because its owner is an admin. JWT/browser admins skip that
// check and still pass the isAdmin gate below.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as RequestQuery;
    if (!id) throw new BadRequestError('Organization id required');

    const { credits, kind, idempotencyKey } = TopUpSchema.parse(req.body);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
    const params = { organizationId: id, credits, kind, idempotencyKey, reason };
    const request = req as unknown as Request;
    const policy = await creditGrantNeedsApproval(credits);
    if (policy) {
      const organization = await organizationRepository.findById(id);
      if (!organization) throw new NotFoundError('Organization not found');
      const pending = await requestApproval(
        request,
        {
          action: 'org.credits.top_up',
          params,
          summary: `${kind === 'refund' ? 'Refund' : 'Top up'} ${credits} credits to org ${organization.name}`,
          reason,
          requiredPermission: 'credits:adjust',
        },
        policy
      );
      return res.status(202).json(pending);
    }
    return res.status(200).json(await topUpOrg(request, params));
  })
);

export default handler;
