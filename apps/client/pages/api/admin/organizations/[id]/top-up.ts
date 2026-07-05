import { creditTransactionRepository, organizationRepository, withTransaction } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { creditService } from '@bike4mind/services';
import { CreditHolderType } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@server/websocket/utils';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { z } from 'zod';
import { Resource } from 'sst';

// Cap protects against admin typo (e.g. an extra zero). 10M credits = ~6 years
// of an MIN-seat subscription. Anything beyond is almost certainly a slip.
const MAX_TOPUP_CREDITS = 10_000_000;

const TopUpSchema = z.object({
  credits: z.number().int().positive().max(MAX_TOPUP_CREDITS),
  reason: z.string().min(1).max(500).optional(),
  // Required idempotency key. The client generates a UUID per submit click so
  // a double-click / retry doesn't double-credit. We piggy-back on the credit-
  // transaction sparse unique index on `stripePaymentIntentId` for atomic
  // dedup at the DB layer.
  idempotencyKey: z.string().min(8).max(128),
});

interface RequestQuery {
  id: string;
}

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as RequestQuery;
    if (!id) throw new BadRequestError('Organization id required');

    const { credits, reason, idempotencyKey } = TopUpSchema.parse(req.body);
    const dedupeKey = `admin_topup_${id}_${idempotencyKey}`;

    const organization = await organizationRepository.findById(id);
    if (!organization) throw new NotFoundError('Organization not found');

    // Atomic credit grant + audit log. Without the transaction, an audit-side
    // failure (analytics outage, etc.) after the credit write would leave a
    // credit-granting action with no audit record - a SOC2 gap on a money
    // path. Idempotency is enforced by the sparse unique index on
    // creditTransactions.stripePaymentIntentId: concurrent duplicates raise
    // E11000, which aborts the transaction (rolling back this attempt's
    // credit write - the original committed write is preserved).
    try {
      await withTransaction(async () => {
        await creditService.addCredits(
          {
            ownerId: organization.id,
            ownerType: CreditHolderType.Organization,
            credits,
            type: 'subscription',
            stripePaymentIntentId: dedupeKey,
            metadata: { adminUserId: req.user!.id, reason, source: 'admin_topup' },
          },
          {
            db: { creditTransactions: creditTransactionRepository },
            creditHolderMethods: organizationRepository,
          }
        );

        await logAuditEvent(
          {
            userId: organization.userId,
            action: AdminOrgAuditEvents.ORG_TOPPED_UP,
            adminUserId: req.user!.id,
            adminUsername: req.user!.username,
            reason,
            metadata: {
              organizationId: organization.id,
              credits,
            },
          },
          req.logger
        );
      });
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000) {
        req.logger.info(`Top-up dedup hit for ${dedupeKey}, treating as success`);
        return res.status(200).json({
          organizationId: organization.id,
          creditsAdded: credits,
          idempotent: true,
        });
      }
      throw err;
    }

    // Notify the org owner so their credit balance refreshes
    await sendToClient(organization.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['organizations'],
    });

    return res.status(200).json({
      organizationId: organization.id,
      creditsAdded: credits,
    });
  })
);

export default handler;
