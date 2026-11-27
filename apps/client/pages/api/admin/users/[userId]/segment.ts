import { z } from 'zod';
import { BadRequestError, NotFoundError, assertCanActOnAdminTarget } from '@bike4mind/common';
import { userRepository, withTransaction } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

// Internal is not settable here: User.isInternal stays the only source of it (see ./internal).
const bodySchema = z.object({ accountSegment: z.enum(['partner', 'customer']) });

/**
 * POST /api/admin/users/[userId]/segment - mark an account as a partner's, or clear the mark
 * (`User.accountSegment`). Customer is the absence of the field, so it is unset rather than stored.
 * Spend explorer splits AI cost by it. Analytics only: it grants and removes nothing. Gated like the
 * internal mark (`settings:manage`), and a delegated admin cannot change an account that holds admin access.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'settings:manage' } }).post(async (req, res) => {
  const userId = req.query.userId;
  if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    throw new BadRequestError("Invalid request body: expected { accountSegment: 'partner' | 'customer' }");
  }
  const { accountSegment } = parsedBody.data;
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

  await withTransaction(async () => {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');
    assertCanActOnAdminTarget(req.user, user, 'change the account segment of');

    const before = user.accountSegment === 'partner' ? 'partner' : 'customer';
    // Unchanged is a no-op: no write and no audit entry, like internal.
    if (before === accountSegment) return;

    await userRepository.setAccountSegment(user.id, accountSegment === 'partner' ? 'partner' : null);

    await recordAdminActionFromRequest(req, {
      action: 'user.segment.changed',
      target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
      summary:
        accountSegment === 'partner' ? 'marked the account as a partner' : 'stopped marking the account as a partner',
      reason,
      changes: [{ field: 'accountSegment', before, after: accountSegment }],
    });
  });

  return res.json({ accountSegment });
});

export const config = { api: { externalResolver: true } };
export default handler;
