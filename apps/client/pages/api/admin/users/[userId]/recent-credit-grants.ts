import {
  ADMIN_GRANT_WINDOW_MS,
  ADMIN_RECENT_CREDIT_GRANTS_LIMIT,
  BadRequestError,
  NotFoundError,
  adminRecentCreditGrantsSchema,
  type AuditActor,
} from '@bike4mind/common';
import { adminAuditLogRepository, userRepository } from '@bike4mind/database';
import { isSelfOrImpersonator } from '@bike4mind/server-utils/utils/adminAudit';
import { immediateGrantLimit, receivedInWindow } from '@server/admin/creditGrants/tierCap';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { respond } from '@server/utils/respond';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

const grantedBy = (actor: AuditActor) => actor.name.trim() || actor.email || 'Unknown admin';

/**
 * GET /api/admin/users/[userId]/recent-credit-grants
 *
 * The admin grants the user received in the grant cap window, from the same audit rows the cap counts
 * (server/admin/creditGrants/tierCap.ts), and the caller's immediate limit for this user, so the grant
 * dialogs can say before submit what runs now and what goes for approval.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'credits:adjust' } }).get(
  asyncHandler(async (req, res) => {
    const { userId } = req.query as { userId?: string | string[] };
    if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user ID');

    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    const since = new Date(Date.now() - ADMIN_GRANT_WINDOW_MS);
    const [receivedCredits, entries] = await Promise.all([
      receivedInWindow('user', user.id),
      adminAuditLogRepository.listCreditGrantsTo(user.id, since, ADMIN_RECENT_CREDIT_GRANTS_LIMIT),
    ]);

    const targetsSelf = isSelfOrImpersonator(req.user, user.id);
    return respond(res, adminRecentCreditGrantsSchema, {
      receivedCredits,
      immediateLimit: immediateGrantLimit(req.user, targetsSelf),
      grants: entries.map(entry => ({
        at: entry.occurredAt.toISOString(),
        credits: Number(entry.details?.credits ?? 0),
        grantedBy: grantedBy(entry.actor),
      })),
    });
  })
);

export default handler;
