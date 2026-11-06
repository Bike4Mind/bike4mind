import { z } from 'zod';
import { BadRequestError, NotFoundError, assertCanActOnAdminTarget } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';
import { scheduleAccountDeletion } from '@server/users/accountDeletion';

const DAY_MS = 24 * 60 * 60 * 1000;

// `receivedAt` may be a calendar day in a timezone ahead of the server's, hence the day of slack.
const bodySchema = z.object({
  receivedAt: z.string().refine(value => {
    const time = Date.parse(value);
    return !Number.isNaN(time) && time <= Date.now() + DAY_MS;
  }, 'receivedAt must be a valid date that is not in the future'),
});

/**
 * POST /api/admin/users/[userId]/schedule-deletion - schedule the account deletion for a user who
 * asked by email and cannot sign in. Same lockdown, 14-day grace, email and purge as the self-serve
 * request; the verification note is the audit reason, and `receivedAt` (when the request email
 * arrived) becomes the deletion's `requestedAt`. The purge date counts from now, not from receipt.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'users:delete' } }).post(async (req, res) => {
  const userId = req.query.userId;
  if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    throw new BadRequestError(parsedBody.error.issues[0]?.message ?? 'Invalid request body: expected { receivedAt }');
  }
  const receivedAt = new Date(parsedBody.data.receivedAt);
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

  const user = await userRepository.findById(userId);
  if (isSelfOrImpersonator(req.user, userId)) {
    await denySelfAdminAction(req, {
      action: 'user.deletion.denied',
      attempted: 'user.deletion.scheduled',
      target: { kind: 'user', id: userId, displayName: user?.name || user?.username || user?.email || userId },
    });
  }
  if (!user) throw new NotFoundError('User not found');
  assertCanActOnAdminTarget(req.user, user, 'schedule deletion for');

  const { deletion, subscriptions } = await scheduleAccountDeletion(req, {
    userId: user.id,
    source: 'support',
    requestedAt: receivedAt,
    actorUserId: req.user.id,
    recordInTransaction: async stamped => {
      await recordAdminActionFromRequest(req, {
        action: 'user.deletion.scheduled',
        target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
        summary: "scheduled account deletion at the user's request",
        reason,
        details: {
          receivedAt: receivedAt.toISOString(),
          scheduledFor: stamped.scheduledFor.toISOString(),
          source: 'support',
        },
      });
    },
  });

  return res.status(202).json({ deletion, canceledSubscriptions: subscriptions.canceled.length });
});

export const config = { api: { externalResolver: true } };
export default handler;
