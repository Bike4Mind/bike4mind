import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { requestApproval } from '@server/admin/approvals/service';
import { creditGrantNeedsApproval } from '@server/admin/creditGrants/gate';
import { GrantOrgSchema, grantOrg, validateGrantOrg } from '@server/admin/creditGrants/grantOrg';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { parseAdminActionReason } from '@server/utils/adminAudit';
import type { Request } from 'express';

// requiredScopes gates the API-key path only: apiKeyAuth 403s an under-scoped key
// before req.user is set, so a key issued for a narrow integration can't create
// an org with an initial credit grant just because its owner is an admin.
// JWT/browser admins skip that check and still pass the isAdmin gate below.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { name, ownerEmail, seats, initialCredits } = GrantOrgSchema.parse(req.body);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
    const params = { name, ownerEmail, seats, initialCredits, reason };
    const request = req as unknown as Request;
    const policy = await creditGrantNeedsApproval(initialCredits);
    if (policy) {
      await validateGrantOrg(params);
      const pending = await requestApproval(
        request,
        {
          action: 'org.credits.grant',
          params,
          summary: `Grant org ${name} with ${initialCredits} credits`,
          reason,
          requiredPermission: 'credits:adjust',
        },
        policy
      );
      return res.status(202).json(pending);
    }
    return res.status(201).json(await grantOrg(request, params));
  })
);

export default handler;
