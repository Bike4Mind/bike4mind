import { z } from 'zod';
import { ApiKeyScope, stripeDisputeItemSchema, stripeDisputeUndoContainRequestSchema } from '@bike4mind/common';
import { stripeDisputeRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError, ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi, requireAdminPermission } from '@server/middlewares/adminApi';
import { usersBulkUndoDeps } from '@server/admin/usersBulk/adapters';
import { SUPERSEDED_MESSAGE } from '@server/admin/usersBulk/undo';
import { DisputeContainUndoRefused, undoDisputeContain } from '@server/billing/stripeDisputes';
import { parseAdminActionReason } from '@server/utils/adminAudit';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const STRIPE_DISPUTE_UNDO_RATE_LIMIT = 10;

export const STRIPE_DISPUTE_NOTHING_TO_UNDO_MESSAGE = 'This dispute has no Contain to undo, or it was already undone.';
export const STRIPE_DISPUTE_ACCOUNT_CHANGED_MESSAGE =
  'The account changed after the Contain, so undoing it could double what was restored. Adjust it by hand.';

const conflictSchema = z.object({ error: z.string(), item: stripeDisputeItemSchema });

/**
 * Undoes the automatic Contain a lost dispute applied: unsuspends the account and restores the credits
 * it took. The API keys it revoked stay off: the dispute flag stays set, so the account stays blocked
 * until a human clears the flag. 409 when the account changed after the Contain. Needs both
 * `credits:adjust` (it writes credits back) and `users:moderate` (it lifts the suspension). Each user
 * change is audited as `user.bulk.undone` by the admin.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'credits:adjust' },
})
  .use(
    rateLimit({
      limit: STRIPE_DISPUTE_UNDO_RATE_LIMIT,
      windowMs: ONE_MINUTE_MS,
      bucket: 'admin-stripe-dispute-undo-contain',
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      requireAdminPermission(req, 'users:moderate');
      const parsed = stripeDisputeUndoContainRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a dispute id and a reason');
      const reason = parseAdminActionReason(parsed.data.reason);

      const dispute = await stripeDisputeRepository.findById(parsed.data.id);
      if (!dispute) throw new NotFoundError('Dispute not found');

      try {
        const item = await undoDisputeContain(dispute, req.user.id, usersBulkUndoDeps(req, req.logger, reason));
        respond(res, stripeDisputeItemSchema, item);
      } catch (error) {
        if (error instanceof DisputeContainUndoRefused) {
          if (error.result.status === 'not_found') throw new NotFoundError('Dispute not found');
          const message =
            error.result.status === 'account_changed'
              ? STRIPE_DISPUTE_ACCOUNT_CHANGED_MESSAGE
              : STRIPE_DISPUTE_NOTHING_TO_UNDO_MESSAGE;
          respond(res, conflictSchema, { error: message, item: error.result.item }, 409);
          return;
        }
        if (error instanceof Error && error.message === SUPERSEDED_MESSAGE) throw new ConflictError(SUPERSEDED_MESSAGE);
        throw error;
      }
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
