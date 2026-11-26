import { ConflictError, NotFoundError, type AdminApproval } from '@bike4mind/common';
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
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import type { Request } from 'express';
import { z } from 'zod';
import { approvalDetails } from './approval';

/** A held self-grant from the profile's credit adjustment: a delta, so spend before approval is kept. */
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
  { userId, creditDelta, creditReason }: SelfCreditAdjustmentParams,
  approval: AdminApproval
) {
  if (!approval.requestedBy.selfIds.includes(userId) && approval.requestedBy.id !== userId) {
    throw new ConflictError('This request no longer targets its requester. It was not run.');
  }
  return withTransaction(async () => {
    const target = await userRepository.findById(userId);
    if (!target) throw new NotFoundError('User not found');
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
      target: { kind: 'user', id: userId, displayName: target.name || target.username || target.email || userId },
      summary: `granted ${credits} credits`,
      reason: creditAdjustment.note,
      changes: [{ field: 'currentCredits', before: previousBalance, after: resultingBalance }],
      details: { credits, selfGrant: true, ...approvalDetails(approval) },
      related: creditTransactionId ? { creditTransactionId } : undefined,
    });
    return { userId, appliedCreditDelta: credits, currentCredits: resultingBalance };
  });
}
