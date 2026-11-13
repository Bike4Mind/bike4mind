import type { Request } from 'express';
import { assertCanActOnAdminTarget, ForbiddenError, NotFoundError, type AdminAuditAction } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
} from '@bike4mind/server-utils/utils/adminAudit';

export type SignupGrantAuditTarget = { kind: 'user'; id: string; displayName: string };

export const signupGrantAuditTarget = (userId: string, displayName: string = userId): SignupGrantAuditTarget => ({
  kind: 'user',
  id: userId,
  displayName,
});

/**
 * The checks every per-user signup grant action runs before touching the account: a valid target, no
 * self-service (denied and audited), a required reason, an existing account, and the actor outranking the target
 * (assertCanActOnAdminTarget, as bulkSignupGrantAdminAction.ts does). The caller has already passed adminApi's
 * permission gate.
 */
export async function readSignupGrantAdminAction(
  req: Request,
  attempted: AdminAuditAction,
  guardTargetVerb: string
): Promise<{ userId: string; reason: string; target: SignupGrantAuditTarget }> {
  const queryUserId = req.query.userId;
  if (typeof queryUserId !== 'string' || !queryUserId) throw new BadRequestError('Invalid user ID');
  const userId = queryUserId.toLowerCase();
  if (!req.user) throw new ForbiddenError('Authentication required');
  if (isSelfOrImpersonator(req.user, userId)) {
    await denySelfAdminAction(req, {
      action: 'user.credits.denied',
      attempted,
      target: signupGrantAuditTarget(userId),
    });
  }
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
  const account = await userRepository.findById(userId);
  if (!account) throw new NotFoundError('User not found');
  assertCanActOnAdminTarget(req.user, account, guardTargetVerb);
  return { userId, reason, target: signupGrantAuditTarget(userId, account.email ?? account.username) };
}
