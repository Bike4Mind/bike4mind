import type { Request } from 'express';
import { z } from 'zod';
import { assertCanActOnAdminTarget, ForbiddenError, type AdminAuditAction } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { BadRequestError } from '@bike4mind/utils';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
} from '@bike4mind/server-utils/utils/adminAudit';
import { signupGrantAuditTarget, type SignupGrantAuditTarget } from './signupGrantAdminAction';

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
): Promise<{
  userIds: string[];
  reason: string | undefined;
  dryRun: boolean;
  /** Audit target per id, with the email or username as its display name; an id with no account is absent. */
  targets: Map<string, SignupGrantAuditTarget>;
}> {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success)
    throw new BadRequestError(`Expected 1 to ${userService.MAX_BULK_SIGNUP_GRANT_ACTION} user ids in userIds`);
  if (!req.user) throw new ForbiddenError('Authentication required');
  const { dryRun = false } = parsed.data;
  const userIds = parsed.data.userIds.map(id => id.toLowerCase());
  for (const userId of userIds) {
    if (!isSelfOrImpersonator(req.user, userId)) continue;
    await denySelfAdminAction(req, {
      action: 'user.credits.denied',
      attempted,
      target: signupGrantAuditTarget(userId),
    });
  }
  const reason = dryRun ? undefined : parseAdminActionReason((req.body as { reason?: unknown }).reason);
  const targets = new Map<string, SignupGrantAuditTarget>();
  for (const account of await userRepository.findAdminTargetsByIds(userIds)) {
    assertCanActOnAdminTarget(req.user, account, guardTargetVerb);
    targets.set(account.id, signupGrantAuditTarget(account.id, account.email ?? account.username));
  }
  return { userIds, reason, dryRun, targets };
}
