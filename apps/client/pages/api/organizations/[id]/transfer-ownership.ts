// POST /api/organizations/:id/transfer-ownership
// Hand billing ownership to an existing org admin. Billing owner or platform admin only.

import { requireEnv } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { organizationRepository } from '@bike4mind/database/infra';
import { userRepository, withTransaction } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { sendOwnershipTransferEmails } from '@server/utils/mailer/ownershipTransferEmail';
import { z } from 'zod';

const bodySchema = z.object({ newOwnerId: z.string().min(1) });

const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    if (!organizationId) throw new BadRequestError('Organization id is required');

    const { newOwnerId } = bodySchema.parse(req.body);

    // The audit write is strict, so it joins the transaction: a failed audit write rolls the transfer back.
    const result = await withTransaction(async () => {
      const transferred = await organizationService.transferOwnership(
        req.user!,
        { organizationId, newOwnerId },
        { db: { organizations: organizationRepository, users: userRepository } }
      );
      await recordAdminActionFromRequest(req, {
        action: 'org.owner.transferred',
        actorScope: 'organization',
        target: { kind: 'organization', id: organizationId, displayName: transferred.organizationName },
        summary: 'transferred organization ownership',
        changes: [{ field: 'userId', before: transferred.previousOwnerId, after: transferred.newOwnerId }],
      });
      return transferred;
    });

    // The Stripe customer belongs to the org, so only its contact email can be stale. Best-effort: the
    // transfer is already committed, and a failed mirror is a stale email on the customer, not a stuck org.
    if (result.billingContactChanged && result.stripeCustomerId && result.billingContact) {
      try {
        await stripe.customers.update(result.stripeCustomerId, { email: result.billingContact });
      } catch (error) {
        req.logger.warn(`Could not mirror the billing contact to Stripe for organization ${organizationId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // After the commit, so a retried transaction cannot mail twice. Best-effort like the Stripe mirror.
    try {
      const [previousOwner, newOwner] = await Promise.all([
        result.previousOwnerId ? userRepository.findById(result.previousOwnerId) : null,
        userRepository.findById(result.newOwnerId),
      ]);
      await sendOwnershipTransferEmails(
        {
          organizationName: result.organizationName,
          organizationUrl: `${requireEnv('APP_URL', process.env.APP_URL)}/organizations/${organizationId}`,
          previousOwner: { email: previousOwner?.email, name: previousOwner?.name },
          newOwner: { email: newOwner?.email, name: newOwner?.name },
        },
        req.logger
      );
    } catch (error) {
      req.logger.warn(`Could not notify the parties to the ownership transfer of organization ${organizationId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return res.status(200).json({ organizationId, ownerId: result.newOwnerId });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
