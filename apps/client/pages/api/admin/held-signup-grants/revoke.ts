import { z } from 'zod';
import { assertCanActOnAdminTarget } from '@bike4mind/common';
import { creditTransactionRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { heldGrantBatches } from '@bike4mind/server-utils/credits/heldSignupGrantAdapters';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  loadCreditGrantPolicy,
  recordAdminActionFromRequest,
} from '@bike4mind/server-utils/utils/adminAudit';

const bodySchema = z.object({ batchId: z.string().regex(/^[a-f0-9]{24}$/i) });

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a batchId');
      const batch = await heldGrantBatches.findBatch(parsed.data.batchId);
      if (!batch) throw new NotFoundError('Release batch not found');
      // The whole batch is refused, like the single-account credit route, rather than partly revoked.
      const revocable = batch.entries.filter(entry => entry.outcome === 'released' && entry.credits > 0);
      for (const entry of revocable) {
        if (!isSelfOrImpersonator(req.user, entry.userId)) continue;
        await denySelfAdminAction(req, {
          action: 'user.credits.denied',
          attempted: 'user.credits.adjusted',
          target: { kind: 'user', id: entry.userId, displayName: entry.userId },
        });
      }
      for (const account of await userRepository.findAdminTargetsByIds(revocable.map(entry => entry.userId)))
        assertCanActOnAdminTarget(req.user, account, 'revoke signup credits from');
      const result = await userService.revokeHeldGrantRelease(
        { batchId: parsed.data.batchId, actorId: req.user.id },
        {
          batches: heldGrantBatches,
          users: userRepository,
          creditTransactions: creditTransactionRepository,
          logger: req.logger,
        }
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
