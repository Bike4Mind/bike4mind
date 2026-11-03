import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import { BadRequestError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  loadCreditGrantPolicy,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';
import { buildHeldGrantAdapters, heldGrantBatches } from '@server/credits/heldSignupGrantAdapters';

const bodySchema = z.object({
  userIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i))
    .min(1)
    .max(userService.MAX_BULK_RELEASE),
});

const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success)
        throw new BadRequestError(`Expected 1 to ${userService.MAX_BULK_RELEASE} user ids in userIds`);
      // The whole request is refused, like the single-account credit route, rather than partly paid.
      for (const userId of parsed.data.userIds) {
        if (!isSelfOrImpersonator(req.user, userId)) continue;
        await denySelfAdminAction(req, {
          action: 'user.credits.denied',
          attempted: 'user.credits.adjusted',
          target: { kind: 'user', id: userId, displayName: userId },
        });
      }
      const result = await userService.bulkReleaseHeldGrants(
        { actorId: req.user.id, userIds: parsed.data.userIds },
        { ...buildHeldGrantAdapters(req.logger), batches: heldGrantBatches }
      );
      let policy: ReturnType<typeof loadCreditGrantPolicy> | undefined;
      for (const row of result.results) {
        if (row.outcome !== 'released' || row.credits <= 0) continue;
        try {
          await recordAdminActionFromRequest(
            req,
            {
              action: 'user.credits.adjusted',
              target: { kind: 'user', id: row.userId, displayName: row.userId },
              summary: 'released held signup grant',
              details: { credits: row.credits, source: 'held_grant_release', batchId: result.batchId },
            },
            { creditGrantPolicy: () => (policy ??= loadCreditGrantPolicy()) }
          );
        } catch (error) {
          req.logger.error(`Audit entry failed for released held grant of user ${row.userId}`, error);
        }
      }
      res.status(200).json(result);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
