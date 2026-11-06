import {
  creditLotRepository,
  creditTransactionRepository,
  organizationRepository,
  withTransaction,
} from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/utils';
import { creditService } from '@bike4mind/services';
import { type AdminApproval, CreditHolderType } from '@bike4mind/common';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { z } from 'zod';
import { Resource } from 'sst';

import type { Request } from 'express';
import { approvalDetails, notifyAfterCommit } from './approval';

// Cap protects against admin typo (e.g. an extra zero). 10M credits = ~6 years
// of an MIN-seat subscription. Anything beyond is almost certainly a slip.
const MAX_TOPUP_CREDITS = 10_000_000;

export const TopUpSchema = z.object({
  credits: z.number().int().positive().max(MAX_TOPUP_CREDITS),
  kind: z.enum(['top_up', 'refund']).default('top_up'),
  // Required idempotency key. The client generates a UUID per submit click so
  // a double-click / retry doesn't double-credit. We piggy-back on the credit-
  // transaction sparse unique index on `stripePaymentIntentId` for atomic
  // dedup at the DB layer.
  idempotencyKey: z.string().min(8).max(128),
});

export const TopUpParamsSchema = TopUpSchema.extend({ organizationId: z.string().min(1), reason: z.string() });
export type TopUpParams = z.infer<typeof TopUpParamsSchema>;

/**
 * Tops up or refunds an org as `req.user`; shared by the route and the approval executor. The
 * stored idempotency key dedupes a replay into `idempotent: true` with no second ledger row.
 */
export async function topUpOrg(req: Request, params: TopUpParams, approval?: AdminApproval) {
  const { organizationId: id, credits, kind, idempotencyKey, reason } = params;
  const isRefund = kind === 'refund';
  // The key is scoped to the kind: a top-up dedupes on stripePaymentIntentId and a refund on
  // transactionId, so a key reused across kinds would slip past both. Top-ups keep the
  // `admin_topup_` infix so keys written before refunds existed still dedupe.
  const dedupeKey = `admin_${isRefund ? 'refund' : 'topup'}_${id}_${idempotencyKey}`;

  const organization = await organizationRepository.findById(id);
  if (!organization) throw new NotFoundError('Organization not found');

  // A generic_add is deduped on transactionId, which createTransaction swallows into a silent
  // no-op rather than the E11000 the subscription path raises. Look the key up first so a
  // replayed refund answers like a replayed top-up and writes no second audit row.
  const idempotentResponse = () => ({
    organizationId: organization.id,
    creditsAdded: credits,
    idempotent: true,
  });

  if (isRefund && (await creditTransactionRepository.findOne({ transactionId: dedupeKey }))) {
    req.logger.info(`Refund dedup hit for ${dedupeKey}, treating as success`);
    return idempotentResponse();
  }

  // Atomic credit grant + audit log. Without the transaction, an audit-side
  // failure (analytics outage, etc.) after the credit write would leave a
  // credit-granting action with no audit record - a SOC2 gap on a money
  // path. Idempotency is enforced by the sparse unique indexes on
  // creditTransactions.stripePaymentIntentId (top-up) and transactionId
  // (refund): a concurrent duplicate aborts the transaction, rolling back
  // this attempt's credit write while the original committed write stands.
  try {
    await withTransaction(async () => {
      const { creditTransactionId } = await creditService.addCreditsWithLedgerRow(
        isRefund
          ? {
              ownerId: organization.id,
              ownerType: CreditHolderType.Organization,
              credits,
              type: 'generic_add',
              reason: 'refund',
              description: 'Admin refund',
              transactionId: dedupeKey,
              metadata: { adminUserId: req.user!.id, reason, source: 'admin_refund' },
            }
          : {
              ownerId: organization.id,
              ownerType: CreditHolderType.Organization,
              credits,
              type: 'subscription',
              stripePaymentIntentId: dedupeKey,
              metadata: { adminUserId: req.user!.id, reason, source: 'admin_topup' },
            },
        {
          db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
          creditHolderMethods: organizationRepository,
          lotFundingSource: 'granted',
          // A refund dedupes on transactionId, which createTransaction swallows. Inside the
          // transaction the duplicate write has already aborted the session, so the duplicate
          // must be raised here rather than re-read: any further operation on the dead session
          // raises a transient NoSuchTransaction and the driver retries the callback for minutes.
          duplicateTransactionId: isRefund ? 'throw' : 'return',
        }
      );

      await recordAdminActionFromRequest(req, {
        action: isRefund ? 'org.credits.refunded' : 'org.credits.topped_up',
        target: { kind: 'organization', id: organization.id, displayName: organization.name },
        summary: `${isRefund ? 'refunded' : 'topped up'} ${credits} credits`,
        reason,
        details: { ...approvalDetails(approval), credits, ownerId: organization.userId, ...(isRefund ? { kind } : {}) },
        related: creditTransactionId ? { creditTransactionId } : undefined,
      });
    });
  } catch (err: unknown) {
    // The winner's row is what the duplicate write collided with, so it is committed: the
    // refund is already in place and this request only has to report success.
    if (err instanceof creditService.DuplicateCreditTransactionError) {
      req.logger.info(`Refund dedup hit for ${dedupeKey}, treating as success`);
      return idempotentResponse();
    }
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000) {
      req.logger.info(`Top-up dedup hit for ${dedupeKey}, treating as success`);
      return idempotentResponse();
    }
    throw err;
  }

  // Notify the org owner so their credit balance refreshes
  await notifyAfterCommit(req, () =>
    sendToClient(organization.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['organizations'],
    })
  );

  return { organizationId: organization.id, creditsAdded: credits };
}
