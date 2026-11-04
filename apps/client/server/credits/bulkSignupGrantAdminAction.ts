import type { Request } from 'express';
import { z } from 'zod';
import { assertCanActOnAdminTarget, ForbiddenError, type AdminAuditAction } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { BadRequestError } from '@bike4mind/utils';
import { denySelfAdminAction, isSelfOrImpersonator, parseAdminActionReason } from '@server/utils/adminAudit';
import { signupGrantAuditTarget } from './signupGrantAdminAction';

const bodySchema = z.object({
  userIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i))
    .min(1)
    .max(userService.MAX_BULK_SIGNUP_GRANT_ACTION),
  dryRun: z.boolean().optional(),
});

/**
 * The checks every bulk signup grant action runs before touching any account. The whole request is refused,
 * not partly applied, when it names the admin's own account or an account the admin may not act on. A dry run
 * writes nothing, so it needs no reason; a real run requires one.
 */
export async function readBulkSignupGrantAction(
  req: Request,
  attempted: AdminAuditAction,
  guardTargetVerb: string
): Promise<{ userIds: string[]; reason: string | undefined; dryRun: boolean }> {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success)
    throw new BadRequestError(`Expected 1 to ${userService.MAX_BULK_SIGNUP_GRANT_ACTION} user ids in userIds`);
  if (!req.user) throw new ForbiddenError('Authentication required');
  const { userIds, dryRun = false } = parsed.data;
  for (const userId of userIds) {
    if (!isSelfOrImpersonator(req.user, userId)) continue;
    await denySelfAdminAction(req, {
      action: 'user.credits.denied',
      attempted,
      target: signupGrantAuditTarget(userId),
    });
  }
  const reason = dryRun ? undefined : parseAdminActionReason((req.body as { reason?: unknown }).reason);
  for (const userId of userIds) {
    const target = await userRepository.findById(userId);
    if (target) assertCanActOnAdminTarget(req.user, target, guardTargetVerb);
  }
  return { userIds, reason, dryRun };
}
