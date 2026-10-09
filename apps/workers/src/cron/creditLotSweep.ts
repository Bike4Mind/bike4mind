/**
 * Reconciles lifetime lot consumption and expires unassigned stale credits.
 * Holder balance, expiry audit and lot assignments commit together.
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
  withTransaction,
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
  const { expiredLots, expiredCredits } = await withTransaction(
    async () => {
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

      for (const { lot, consumedAssigned } of assigned) {
        const isStale = lot.expiresAt.getTime() <= now.getTime();
        // Balance top-ups must not reopen consumption settled on an expired lot.
        const settled = Math.min(lot.amount, Math.max(0, lot.consumedAssigned));
        let finalConsumedAssigned = isStale ? Math.max(consumedAssigned, settled) : consumedAssigned;
        const remaining = lot.amount - finalConsumedAssigned;

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
          const updated = await creditLotRepository.update({ id: lot.id, consumedAssigned: finalConsumedAssigned });
          if (!updated) throw new Error('Failed to update credit lot');
        }
      }
      return { expiredLots, expiredCredits };
    },
    { logger }
  );

  if (expiredLots > 0) {
    logger.info(`[CreditLotSweep] Expired ${expiredLots} lot(s) for ${ownerType} ${ownerId}`, {
      expiredCredits,
    });
  }

  return { expiredLots, expiredCredits };
}

export async function runCreditLotSweep(logger = new Logger()) {
  const now = new Date();
  let holdersProcessed = 0;
  let holdersFailed = 0;
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
      // Isolate per-holder failures: a single holder that throws (e.g. its doc
      // was concurrently deleted, so subtractCredits can't decrement) must not
      // abort the batch. Because holders are swept in a stable $sort order, an
      // unhandled throw here would permanently block every later holder. The
      // sweep is idempotent, so a skipped holder self-heals on the next run.
      try {
        const { expiredLots, expiredCredits } = await processHolder(holderKey, now, logger);
        totalExpiredLots += expiredLots;
        totalExpiredCredits += expiredCredits;
      } catch (err) {
        holdersFailed++;
        logger.error(`[CreditLotSweep] Failed to process ${holderKey.ownerType} ${holderKey.ownerId}`, err);
      }
    }

    holdersProcessed += batch.length;
    skip += HOLDER_BATCH_SIZE;
  }

  logger.log(
    `[CreditLotSweep] Processed ${holdersProcessed} holder(s) (${holdersFailed} failed): expired ${totalExpiredLots} lot(s) totalling ${totalExpiredCredits} credits`
  );

  return {
    holdersProcessed,
    holdersFailed,
    expiredLots: totalExpiredLots,
    expiredCredits: totalExpiredCredits,
  };
}

export async function handler(event: never, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  logger.log('[CreditLotSweep] Connected to database');
  return { statusCode: 200, body: JSON.stringify(await runCreditLotSweep(logger)) };
}
