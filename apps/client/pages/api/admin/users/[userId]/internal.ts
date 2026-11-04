import { z } from 'zod';
import { BadRequestError, NotFoundError, assertCanActOnAdminTarget } from '@bike4mind/common';
import { userRepository, withTransaction } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

const bodySchema = z.object({ isInternal: z.boolean() });

/**
 * POST /api/admin/users/[userId]/internal - mark an account as the team's own, or stop marking it
 * (`User.isInternal`). Its events then carry `internal: true` to the analytics consumer
 * (server-utils analytics/lane.ts), which keeps them out of customer counts.
 *
 * For accounts the signup rule cannot see, such as a contractor or a partner on a personal email:
 * staff-domain accounts are marked at signup, and an admin is marked whatever this flag says.
 * Analytics only: it grants and removes nothing. Gated like other account settings
 * (`settings:manage`), and a delegated admin cannot change an account that holds admin access.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'settings:manage' } }).post(async (req, res) => {
  const userId = req.query.userId;
  if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) throw new BadRequestError('Invalid request body: expected { isInternal: boolean }');
  const { isInternal } = parsedBody.data;
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

  await withTransaction(async () => {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');
    assertCanActOnAdminTarget(req.user, user, 'change the internal mark on');

    const before = user.isInternal === true;
    // Unchanged is a no-op: no write and no audit entry, like api-key-trust.
    if (before === isInternal) return;

    await userRepository.update({ id: user.id, isInternal });

    await recordAdminActionFromRequest(req, {
      action: isInternal ? 'user.internal.marked' : 'user.internal.unmarked',
      target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
      summary: isInternal ? 'marked the account as internal' : 'stopped marking the account as internal',
      reason,
      changes: [{ field: 'isInternal', before, after: isInternal }],
    });
  });

  return res.json({ isInternal });
});

export const config = { api: { externalResolver: true } };
export default handler;
