import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { getTeamPlanSettings } from '@bike4mind/server-utils/services/teamPlanSettings';
import { requestApproval } from '@server/admin/approvals/service';
import { creditGrantNeedsApproval } from '@server/admin/creditGrants/gate';
import {
  GrantSubscriptionSchema,
  grantSubscription,
  grantSubscriptionCredits,
  validateGrantSubscription,
} from '@server/admin/creditGrants/grantSubscription';
import { assertDelegateCanCreditUser } from '@server/admin/creditGrants/delegateTargets';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { parseAdminActionReason } from '@bike4mind/server-utils/utils/adminAudit';
import type { Request } from 'express';

interface RequestQuery {
  userId: string;
}

const handler = adminApi({ requiredScopes: [ApiKeyScope.ADMIN], adminPermissions: { POST: 'credits:adjust' } }).post(
  asyncHandler(async (req, res) => {
    const { userId } = req.query as RequestQuery;
    const teamPlan = await getTeamPlanSettings();
    const parsed = GrantSubscriptionSchema.parse(req.body);
    if (typeof userId !== 'string' || !userId) {
      throw new BadRequestError('Invalid user ID');
    }
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
    const params = { ...parsed, seats: parsed.seats ?? teamPlan.minSeats, userId, reason };
    const request = req as unknown as Request;

    const credits = grantSubscriptionCredits(params, teamPlan);
    const gate = await creditGrantNeedsApproval(credits, req.user.id);
    if (gate.policy) {
      const user = await validateGrantSubscription(params, teamPlan);
      await assertDelegateCanCreditUser(req.user, user.id, 'grant a subscription to');
      const pending = await requestApproval(
        request,
        {
          action: 'user.subscription.grant',
          params: { ...params, creditsAtRequest: credits },
          summary: `Grant ${params.subscriptionType} subscription with ${credits} credits to ${user.email ?? user.username}`,
          reason,
          requiredPermission: 'credits:adjust',
          requiresFullAdmin: false,
        },
        gate.policy
      );
      return res.status(202).json(pending);
    }
    try {
      return res.status(200).json(await grantSubscription(request, params));
    } finally {
      await gate.release();
    }
  })
);

export default handler;
