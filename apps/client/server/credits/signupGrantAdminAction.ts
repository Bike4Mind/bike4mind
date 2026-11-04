import type { Request } from 'express';
import { assertCanActOnAdminTarget, ForbiddenError, NotFoundError, type AdminAuditAction } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { denySelfAdminAction, isSelfOrImpersonator, parseAdminActionReason } from '@server/utils/adminAudit';

export const signupGrantAuditTarget = (userId: string) => ({ kind: 'user' as const, id: userId, displayName: userId });

/**
 * The checks every per-user signup grant action runs before touching the account: a valid target, no
 * self-service (denied and audited), a required reason, and - for actions that change an account's restriction
 * state (block, unblock) - the actor outranking the target. The caller has already passed adminApi's permission gate.
 */
export async function readSignupGrantAdminAction(
  req: Request,
  attempted: AdminAuditAction,
  options: { guardTargetVerb?: string } = {}
): Promise<{ userId: string; reason: string }> {
  const userId = req.query.userId;
  if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');
  if (!req.user) throw new ForbiddenError('Authentication required');
  if (isSelfOrImpersonator(req.user, userId)) {
    await denySelfAdminAction(req, {
      action: 'user.credits.denied',
      attempted,
      target: signupGrantAuditTarget(userId),
    });
  }
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
  if (options.guardTargetVerb) {
    const target = await userRepository.findById(userId);
    if (!target) throw new NotFoundError('User not found');
    assertCanActOnAdminTarget(req.user, target, options.guardTargetVerb);
  }
  return { userId, reason };
}
