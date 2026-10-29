import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import { creditTransactionRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { BadRequestError, NotFoundError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { heldGrantBatches } from '@server/credits/heldSignupGrantAdapters';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  loadCreditGrantPolicy,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';

const bodySchema = z.object({ batchId: z.string().regex(/^[a-f0-9]{24}$/i) });

const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a batchId');
      const batch = await heldGrantBatches.findBatch(parsed.data.batchId);
      if (!batch) throw new NotFoundError('Release batch not found');
      // The whole batch is refused, like the single-account credit route, rather than partly revoked.
      for (const entry of batch.entries) {
        if (entry.outcome !== 'released' || entry.credits <= 0 || !isSelfOrImpersonator(req.user, entry.userId))
          continue;
        await denySelfAdminAction(req, {
          action: 'user.credits.denied',
          attempted: 'user.credits.adjusted',
          target: { kind: 'user', id: entry.userId, displayName: entry.userId },
        });
      }
      const result = await userService.revokeHeldGrantRelease(
        { batchId: parsed.data.batchId, actorId: req.user.id },
        { batches: heldGrantBatches, users: userRepository, creditTransactions: creditTransactionRepository }
      );
      if (!result) throw new NotFoundError('Release batch not found');
      let policy: ReturnType<typeof loadCreditGrantPolicy> | undefined;
      for (const row of result.results) {
        if (row.outcome !== 'reversed') continue;
        try {
          await recordAdminActionFromRequest(
            req,
            {
              action: 'user.credits.adjusted',
              target: { kind: 'user', id: row.userId, displayName: row.userId },
              summary: 'revoked released signup grant',
              details: { credits: -row.credits, source: 'held_grant_revoke', batchId: result.batchId },
            },
            { creditGrantPolicy: () => (policy ??= loadCreditGrantPolicy()) }
          );
        } catch (error) {
          req.logger.error(`Audit entry failed for revoked held grant of user ${row.userId}`, error);
        }
      }
      res.status(200).json(result);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
