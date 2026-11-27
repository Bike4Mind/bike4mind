import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { getTeamPlanSettings } from '@bike4mind/server-utils/services/teamPlanSettings';
import { requestApproval, type ApprovalPolicy, type RequestApprovalInput } from '@server/admin/approvals/service';
import { creditGrantNeedsApproval } from '@server/admin/creditGrants/gate';
import {
  GrantSubscriptionSchema,
  checkGrantSubscriptionCap,
  grantSubscription,
  grantSubscriptionCredits,
  grantSubscriptionTargetIds,
  validateGrantSubscription,
} from '@server/admin/creditGrants/grantSubscription';
import { assertDelegateCanCreditUser } from '@server/admin/creditGrants/delegateTargets';
import { SELF_GRANT_APPROVAL } from '@server/admin/creditGrants/selfGrant';
import { LARGE_GRANT_APPROVAL } from '@server/admin/creditGrants/tierCap';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { isSelfOrImpersonator, parseAdminActionReason } from '@bike4mind/server-utils/utils/adminAudit';
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
    const targetIds = await grantSubscriptionTargetIds(params);
    const user = await validateGrantSubscription(params, teamPlan);
    await assertDelegateCanCreditUser(req.user, user.id, 'grant a subscription to');
    const queue = async (
      approver: Pick<RequestApprovalInput, 'requiredPermission' | 'requiresFullAdmin'>,
      policy?: ApprovalPolicy
    ) => {
      const pending = await requestApproval(
        request,
        {
          action: 'user.subscription.grant',
          params: { ...params, creditsAtRequest: credits },
          summary: `Grant ${params.subscriptionType} subscription with ${credits} credits to ${user.email ?? user.username}`,
          reason,
          ...approver,
        },
        policy
      );
      return res.status(202).json(pending);
    };

    // Before the approval gate: past the admin's immediate limit the whole grant goes to a listed approver,
    // whatever the approval settings. grantSubscription reserves it when it runs.
    const cap = await checkGrantSubscriptionCap(request, params, credits, user, {
      targetIds,
      reserve: false,
      approvalAvailable: true,
    });
    if (cap.outcome === 'approval') return queue(LARGE_GRANT_APPROVAL);
    const gate = await creditGrantNeedsApproval(credits, req.user.id);
    if (gate.policy) {
      // A grant to the admin's own account that the approval settings hold still needs a self-grant approver.
      const targetsSelf = targetIds.some(id => isSelfOrImpersonator(req.user, id));
      return queue(
        targetsSelf ? SELF_GRANT_APPROVAL : { requiredPermission: 'credits:adjust', requiresFullAdmin: false },
        gate.policy
      );
    }
    try {
      return res.status(200).json(await grantSubscription(request, params));
    } finally {
      await gate.release();
    }
  })
);

export default handler;
