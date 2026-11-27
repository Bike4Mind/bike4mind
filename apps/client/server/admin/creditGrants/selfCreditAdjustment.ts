import { ConflictError, ForbiddenError, NotFoundError, type AdminApproval } from '@bike4mind/common';
import {
  Organization,
  creditTransactionRepository,
  friendshipRepository,
  realtimeConnectionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userService } from '@bike4mind/services';
import { resolveRoleAdminPermissions } from '@bike4mind/server-utils/auth/adminRoles';
import { isSelfOrImpersonator, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import type { Request } from 'express';
import { z } from 'zod';
import { approvalDetails } from './approval';
import { assertDelegateCanCreditUser } from './delegateTargets';
import { enforceImmediateCreditGrant, isLargeGrantApproval } from './tierCap';

/** A held grant from the profile's credit adjustment: a delta, so spend before approval is kept. */
export const SelfCreditAdjustmentParamsSchema = z
  .object({ userId: z.string(), creditDelta: z.number().int().positive(), creditReason: z.string() })
  .strict();
export type SelfCreditAdjustmentParams = z.infer<typeof SelfCreditAdjustmentParamsSchema>;

/**
 * Applies an approved `user.credits.self_grant`, refusing one whose target is no longer the requester's account.
 * The audit records the approver and the approval.
 */
export async function applyApprovedSelfCreditAdjustment(
  req: Request,
  params: SelfCreditAdjustmentParams,
  approval: AdminApproval
) {
  if (!approval.requestedBy.selfIds.includes(params.userId) && approval.requestedBy.id !== params.userId) {
    throw new ConflictError('This request no longer targets its requester. It was not run.');
  }
  return applyApprovedCreditAdjustment(req, params, approval, { selfGrant: true });
}

/**
 * Applies an approved `user.credits.grant`: a grant to another user over the requester's immediate limit
 * (tierCap.ts). It runs as the approver, who must be able to credit the user and must not be the user.
 */
export async function applyApprovedCreditGrant(
  req: Request,
  params: SelfCreditAdjustmentParams,
  approval: AdminApproval
) {
  if (isSelfOrImpersonator(req.user!, params.userId)) {
    throw new ForbiddenError('You cannot approve a credit grant to your own account');
  }
  await assertDelegateCanCreditUser(req.user!, params.userId, 'grant credits to');
  return applyApprovedCreditAdjustment(req, params, approval, { selfGrant: false });
}

/** Held to the hard limit (tierCap.ts) and reserved until written: the approval lifts only the immediate limit. */
async function applyApprovedCreditAdjustment(
  req: Request,
  { userId, creditDelta, creditReason }: SelfCreditAdjustmentParams,
  approval: AdminApproval,
  { selfGrant }: { selfGrant: boolean }
) {
  const target = await userRepository.findById(userId);
  if (!target) throw new NotFoundError('User not found');
  const displayName = target.name || target.username || target.email || userId;
  const release = await enforceImmediateCreditGrant(
    {
      actor: req.user!,
      recipient: { id: userId, displayName },
      credits: creditDelta,
      // The actor is the approver, never the target (isOwnRequest, assertApproverOutsideTargets).
      targetsSelf: false,
      approved: isLargeGrantApproval(approval),
      reason: creditReason,
      attemptedAction: 'user.credits.adjusted',
    },
    input =>
      recordAdminActionFromRequest(req, { ...input, details: { ...approvalDetails(approval), ...input.details } })
  );
  try {
    return await withTransaction(async () => {
      const { creditAdjustment } = await userService.adminUpdateUser(
        userId,
        { id: userId, creditDelta, creditReason },
        {
          db: {
            users: userRepository,
            organizations: Organization,
            friendship: friendshipRepository,
            userApiKeys: userApiKeyRepository,
            realtimeConnections: realtimeConnectionRepository,
            creditTransactions: creditTransactionRepository,
          },
          resolveAdminRoles: resolveRoleAdminPermissions,
        }
      );
      if (!creditAdjustment) throw new ConflictError('No credits were applied.');
      const { credits, previousBalance, resultingBalance, creditTransactionId } = creditAdjustment;
      await recordAdminActionFromRequest(req, {
        action: 'user.credits.adjusted',
        target: { kind: 'user', id: userId, displayName },
        summary: `granted ${credits} credits`,
        reason: creditAdjustment.note,
        changes: [{ field: 'currentCredits', before: previousBalance, after: resultingBalance }],
        details: { credits, ...(selfGrant && { selfGrant: true }), ...approvalDetails(approval) },
        related: creditTransactionId ? { creditTransactionId } : undefined,
      });
      return { userId, appliedCreditDelta: credits, currentCredits: resultingBalance };
    });
  } finally {
    await release();
  }
}
