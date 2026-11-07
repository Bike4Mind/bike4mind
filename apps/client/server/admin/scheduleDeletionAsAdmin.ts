import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError, canAccessAdmin, type AdminApproval } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import type { Request } from 'express';
import { isSelfOrImpersonator, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { scheduleAccountDeletion } from '@server/users/accountDeletion';
import { approvalDetails } from '@server/admin/creditGrants/approval';

const DAY_MS = 24 * 60 * 60 * 1000;

// `receivedAt` may be a calendar day in a timezone ahead of the server's, hence the day of slack.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const isRealCalendarDate = (value: string): boolean => {
  const time = Date.parse(value);
  // Date.parse rolls 2026-02-30 over to March 2; the round trip catches it.
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value.slice(0, 10);
};

// Only `YYYY-MM-DD` or a UTC ISO datetime: Date.parse alone also accepts "1" or "Nov 5".
export const ScheduleDeletionSchema = z.object({
  receivedAt: z
    .string()
    .refine(
      value => (DATE_ONLY.test(value) || z.string().datetime().safeParse(value).success) && isRealCalendarDate(value),
      'receivedAt must be a valid date (YYYY-MM-DD)'
    )
    .refine(value => Date.parse(value) <= Date.now() + DAY_MS, 'receivedAt cannot be in the future'),
});

export const ScheduleAdminDeletionParamsSchema = ScheduleDeletionSchema.extend({
  userId: z.string().min(1),
  reason: z.string(),
});
export type ScheduleAdminDeletionParams = z.infer<typeof ScheduleAdminDeletionParamsSchema>;

/** Preserves the support-request grace period; an approval schedules deletion rather than hard-deleting. */
export async function scheduleDeletionAsAdmin(
  req: Request,
  params: ScheduleAdminDeletionParams,
  approval?: AdminApproval,
  options: { requireNonAdmin?: boolean } = {}
) {
  const { userId, receivedAt, reason } = params;
  if (isSelfOrImpersonator(req.user!, userId) || approval?.requestedBy.selfIds.includes(userId)) {
    throw new ForbiddenError('Admins cannot schedule deletion for their own account.');
  }
  const assertTargetRole = async () => {
    const target = await userRepository.findById(userId);
    if (!target) throw new NotFoundError('User not found');
    if (approval && !canAccessAdmin(target)) {
      throw new ConflictError('This user is no longer an admin; request the deletion again.');
    }
    if (options.requireNonAdmin && canAccessAdmin(target)) {
      throw new ConflictError('This user now has admin access; request the deletion again for approval.');
    }
    return target;
  };
  const user = await assertTargetRole();
  const { deletion, subscriptions } = await scheduleAccountDeletion(req, {
    userId,
    source: 'support',
    requestedAt: new Date(receivedAt),
    actorUserId: req.user!.id,
    recordInTransaction: async stamped => {
      // A changed role aborts the stamp before any credentials are revoked or subscriptions canceled.
      if (approval || options.requireNonAdmin) await assertTargetRole();
      await recordAdminActionFromRequest(req, {
        action: 'user.deletion.scheduled',
        target: { kind: 'user', id: user.id, displayName: user.name || user.username || user.email || user.id },
        summary: "scheduled account deletion at the user's request",
        reason,
        details: {
          receivedAt: new Date(receivedAt).toISOString(),
          scheduledFor: stamped.scheduledFor.toISOString(),
          source: 'support',
          ...approvalDetails(approval),
        },
      });
    },
  });
  return { deletion, canceledSubscriptions: subscriptions.canceled.length };
}
