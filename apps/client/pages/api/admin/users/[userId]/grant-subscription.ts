import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { getTeamPlanSettings } from '@bike4mind/server-utils/services/teamPlanSettings';
import { requestApproval } from '@server/admin/approvals/service';
import { creditGrantNeedsApproval } from '@server/admin/creditGrants/gate';
import {
  GrantSubscriptionSchema,
  grantSubscription,
  grantSubscriptionCredits,
  validateGrantSubscription,
} from '@server/admin/creditGrants/grantSubscription';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { parseAdminActionReason } from '@server/utils/adminAudit';
import type { Request } from 'express';

interface RequestQuery {
  userId: string;
}

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

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
    const policy = await creditGrantNeedsApproval(credits);
    if (policy) {
      const user = await validateGrantSubscription(params, teamPlan);
      const pending = await requestApproval(
        request,
        {
          action: 'user.subscription.grant',
          params: { ...params, creditsAtRequest: credits },
          summary: `Grant ${params.subscriptionType} subscription with ${credits} credits to ${user.email ?? user.username}`,
          reason,
          requiredPermission: 'credits:adjust',
        },
        policy
      );
      return res.status(202).json(pending);
    }
    return res.status(200).json(await grantSubscription(request, params));
  })
);

export default handler;
