import { z } from 'zod';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, withTransaction } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

interface RequestQuery {
  userId: string;
}

const bodySchema = z.object({ lifted: z.boolean() });

// Admin-only endpoint to exempt (or stop exempting) a young account from the new-account spend cap
// (creditService/newAccountSpendCap.ts) before it ages out of it.
const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { userId } = req.query as RequestQuery;

      if (typeof userId !== 'string' || !userId) {
        throw new BadRequestError('Invalid user ID');
      }

      const parsedBody = bodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new BadRequestError('Invalid request body: expected { lifted: boolean }');
      }
      const { lifted } = parsedBody.data;
      const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

      await withTransaction(async () => {
        const user = await userRepository.findById(userId);

        if (!user) {
          throw new BadRequestError('User not found');
        }

        const before = user.newAccountSpendCapLifted === true;
        // Unchanged is a no-op: no write and no audit entry, like verify-email on an already-verified user.
        if (before === lifted) return;

        await userRepository.update({ id: user.id, newAccountSpendCapLifted: lifted });

        await recordAdminActionFromRequest(req, {
          action: lifted ? 'user.new_account_spend_cap.lifted' : 'user.new_account_spend_cap.restored',
          target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
          summary: lifted ? 'lifted the new-account spend cap' : 'restored the new-account spend cap',
          reason,
          changes: [{ field: 'newAccountSpendCapLifted', before, after: lifted }],
        });

        req.logger.info(
          `Admin ${req.user.username} (${req.user.id}) set newAccountSpendCapLifted=${lifted} for user ${user.username} (${userId})`
        );
      });

      return res.json({ newAccountSpendCapLifted: lifted });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
