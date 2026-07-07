/**
 * Credit Lot Sweep
 *
 * Reconciles the CreditLot parallel ledger against each holder's
 * `currentCredits`: recomputes cumulative consumption and attributes it to
 * lots soonest-to-expire-first, then expires (decrements + audits) whatever
 * remains unassigned on lots past their `expiresAt`.
 *
 * `currentCredits` is never gated by this sweep - it is read-and-decrement
 * only, on the stale-remainder path. Lots never gate a charge.
 *
 * Idempotent by construction: once a stale lot's `consumedAssigned` reaches
 * `amount`, its remainder is 0 and re-running the sweep is a no-op for that
 * lot. See CreditLotTypes.ts / creditLotAssignment.ts for the invariant.
 *
 * Schedule: daily
 * Enabled: production + dev
 */

import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import {
  agentRepository,
  connectDB,
  CreditLot,
  creditLotRepository,
  creditTransactionRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { CreditHolderType, ICreditHolderMethods } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

interface HolderMethods extends ICreditHolderMethods {
  findById(id: string): Promise<{ currentCredits: number } | null>;
}

const HOLDER_METHODS_BY_TYPE: Record<CreditHolderType, HolderMethods> = {
  [CreditHolderType.User]: userRepository,
  [CreditHolderType.Organization]: organizationRepository,
  [CreditHolderType.Agent]: agentRepository,
};

const HOLDER_BATCH_SIZE = 500;

interface HolderKey {
  ownerId: string;
  ownerType: CreditHolderType;
}

export async function processHolder(
  { ownerId, ownerType }: HolderKey,
  now: Date,
  logger: Logger
): Promise<{ expiredLots: number; expiredCredits: number }> {
  const holderMethods = HOLDER_METHODS_BY_TYPE[ownerType];
  const holder = await holderMethods.findById(ownerId);
  if (!holder || holder.currentCredits <= 0) {
    return { expiredLots: 0, expiredCredits: 0 };
  }

  const lots = await creditLotRepository.findByOwner(ownerId, ownerType);
  if (lots.length === 0) {
    return { expiredLots: 0, expiredCredits: 0 };
  }

  const consumption = creditService.computeConsumption(lots, holder.currentCredits);
  const assigned = creditService.assignConsumptionFIFO(lots, consumption);

  let remainingBalance = holder.currentCredits;
  let expiredLots = 0;
  let expiredCredits = 0;

  for (const { lot, consumedAssigned, remaining } of assigned) {
    const isStale = lot.expiresAt.getTime() <= now.getTime();
    let finalConsumedAssigned = consumedAssigned;

    if (isStale && remaining > 0) {
      const dec = Math.min(remaining, remainingBalance);
      if (dec > 0) {
        await creditService.subtractCredits(
          {
            type: 'generic_deduct',
            ownerId,
            ownerType,
            credits: dec,
            reason: 'credit_expiry',
            description: `Credit lot ${lot.id} (source: ${lot.source}) expired ${lot.expiresAt.toISOString()}`,
          },
          {
            db: { creditTransactions: creditTransactionRepository },
            creditHolderMethods: holderMethods,
          }
        );
        remainingBalance -= dec;
        expiredCredits += dec;
        expiredLots++;
      }
      // Mark fully realized regardless of the clamp above - a partial decrement
      // (balance ran dry mid-run) still retires the lot; the clamp exists to
      // protect currentCredits, not to keep the lot "pending" forever.
      finalConsumedAssigned = lot.amount;
    }

    if (finalConsumedAssigned !== lot.consumedAssigned) {
      await creditLotRepository.update({ id: lot.id, consumedAssigned: finalConsumedAssigned });
    }
  }

  if (expiredLots > 0) {
    logger.info(`[CreditLotSweep] Expired ${expiredLots} lot(s) for ${ownerType} ${ownerId}`, {
      expiredCredits,
    });
  }

  return { expiredLots, expiredCredits };
}

export async function handler(event: never, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  logger.log('[CreditLotSweep] Connected to database');

  const now = new Date();
  let holdersProcessed = 0;
  let totalExpiredLots = 0;
  let totalExpiredCredits = 0;
  let skip = 0;

  while (true) {
    const batch: { _id: HolderKey }[] = await CreditLot.aggregate([
      { $group: { _id: { ownerId: '$ownerId', ownerType: '$ownerType' } } },
      { $sort: { '_id.ownerId': 1, '_id.ownerType': 1 } },
      { $skip: skip },
      { $limit: HOLDER_BATCH_SIZE },
    ]);

    if (batch.length === 0) break;

    for (const { _id: holderKey } of batch) {
      const { expiredLots, expiredCredits } = await processHolder(holderKey, now, logger);
      totalExpiredLots += expiredLots;
      totalExpiredCredits += expiredCredits;
    }

    holdersProcessed += batch.length;
    skip += HOLDER_BATCH_SIZE;
  }

  logger.log(
    `[CreditLotSweep] Processed ${holdersProcessed} holder(s): expired ${totalExpiredLots} lot(s) totalling ${totalExpiredCredits} credits`
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      holdersProcessed,
      expiredLots: totalExpiredLots,
      expiredCredits: totalExpiredCredits,
    }),
  };
}
