import { ApiKeyScope } from '@bike4mind/common';
import { requestApproval } from '@server/admin/approvals/service';
import { creditGrantNeedsApproval } from '@server/admin/creditGrants/gate';
import { GrantOrgSchema, grantOrg, validateGrantOrg } from '@server/admin/creditGrants/grantOrg';
import { assertDelegateCanCreditUser } from '@server/admin/creditGrants/delegateTargets';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { parseAdminActionReason } from '@bike4mind/server-utils/utils/adminAudit';
import type { Request } from 'express';

const handler = adminApi({ requiredScopes: [ApiKeyScope.ADMIN], adminPermissions: { POST: 'credits:adjust' } }).post(
  asyncHandler(async (req, res) => {
    const { name, ownerEmail, seats, initialCredits } = GrantOrgSchema.parse(req.body);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
    const params = { name, ownerEmail, seats, initialCredits, reason };
    const request = req as unknown as Request;
    const gate = await creditGrantNeedsApproval(initialCredits, req.user.id);
    if (gate.policy) {
      const owner = await validateGrantOrg(params);
      await assertDelegateCanCreditUser(req.user, owner.id, 'grant an organization to');
      const pending = await requestApproval(
        request,
        {
          action: 'org.credits.grant',
          params,
          summary: `Grant org ${name} with ${initialCredits} credits`,
          reason,
          requiredPermission: 'credits:adjust',
          requiresFullAdmin: false,
        },
        gate.policy
      );
      return res.status(202).json(pending);
    }
    try {
      return res.status(201).json(await grantOrg(request, params));
    } finally {
      await gate.release();
    }
  })
);

export default handler;
