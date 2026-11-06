import { z } from 'zod';
import { ApiKeyScope, stripeDisputeItemSchema, stripeDisputeResolveRequestSchema } from '@bike4mind/common';
import { stripeDisputeRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { disputeAuditDetails } from '@server/billing/stripeDisputes';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const STRIPE_DISPUTE_RESOLVE_RATE_LIMIT = 60;

export const STRIPE_DISPUTE_NOT_RESOLVABLE_MESSAGE =
  'This dispute is already resolved, or belongs to a user and resolves from its Stripe outcome once Stripe closes it.';

const conflictSchema = z.object({ error: z.string(), item: stripeDisputeItemSchema });

/**
 * Resolves an open organization or unmatched dispute with the admin's note. Only the record changes:
 * resolving never touches an account, a dispute flag or credits.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:moderate' },
})
  .use(
    rateLimit({
      limit: STRIPE_DISPUTE_RESOLVE_RATE_LIMIT,
      windowMs: ONE_MINUTE_MS,
      bucket: 'admin-stripe-dispute-resolve',
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const parsed = stripeDisputeResolveRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a dispute id and a reason');
      const reason = parseAdminActionReason(parsed.data.reason);

      const result = await stripeDisputeRepository.resolveByAdmin({
        id: parsed.data.id,
        adminId: req.user.id,
        note: reason,
      });
      if (result.status === 'not_found') throw new NotFoundError('Dispute not found');
      if (result.status === 'conflict') {
        respond(res, conflictSchema, { error: STRIPE_DISPUTE_NOT_RESOLVABLE_MESSAGE, item: result.item }, 409);
        return;
      }

      // The resolution has already committed: a failed audit write must not turn it into a 500.
      try {
        await recordAdminActionFromRequest(req, {
          action: 'billing.dispute.resolved',
          target: {
            kind: 'system',
            id: result.item.stripeDisputeId,
            displayName: `Stripe dispute ${result.item.stripeDisputeId}`,
          },
          summary: `resolved an ${result.item.subject} Stripe dispute`,
          reason,
          details: disputeAuditDetails(result.item),
        });
      } catch (error) {
        req.logger.error(`Audit entry failed for resolved dispute ${result.item.stripeDisputeId}`, error);
      }
      respond(res, stripeDisputeItemSchema, result.item);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
