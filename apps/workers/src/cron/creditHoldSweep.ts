/**
 * Refunds request credit holds that were never settled or refunded: the process serving the request died
 * between reserve and settle (Lambda timeout, OOM, crash), so the reserved credits would stay locked forever.
 * Holds are recorded by apps/client/server/billing/reserveRequestCredits.ts with an expiry far past the
 * longest request, so only abandoned holds are swept.
 *
 * Each hold is claimed (its pending row deleted) in the same transaction as its refund, the same claim settle
 * and refund take, so a late settle, a concurrent refund and an overlapping sweep run never return the same
 * credits twice, and a refund that fails rolls the claim back for the next run to retry.
 *
 * Schedule: rate(15 minutes) (infra/cron.ts creditHoldSweep).
 * Self-host: apps/workers/src/selfhost/creditHoldSweep.ts.
 */
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import {
  connectDB,
  organizationRepository,
  pendingCreditHoldRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { creditService } from '@bike4mind/services';
import { emitMetrics as putMetrics } from '@server/utils/cloudwatch';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'creditHoldSweep' } });

const CLOUDWATCH_NAMESPACE = 'Lumina5/CreditHolds';
// Per-run cap; a backlog drains over successive runs, oldest first.
export const CREDIT_HOLD_SWEEP_LIMIT = 200;

export interface CreditHoldSweepResult {
  candidates: number;
  reclaimed: number;
  reclaimedCredits: number;
  alreadyClaimed: number;
  failed: number;
}

export async function runCreditHoldSweep({
  now = new Date(),
  emitMetrics = true,
}: { now?: Date; emitMetrics?: boolean } = {}): Promise<CreditHoldSweepResult> {
  const expired = await pendingCreditHoldRepository.findExpired(now, CREDIT_HOLD_SWEEP_LIMIT);
  const result: CreditHoldSweepResult = {
    candidates: expired.length,
    reclaimed: 0,
    reclaimedCredits: 0,
    alreadyClaimed: 0,
    failed: 0,
  };

  for (const candidate of expired) {
    try {
      const hold = await withTransaction(async () => {
        const claimed = await pendingCreditHoldRepository.claimExpired(candidate.id, now);
        if (claimed) {
          await creditService.releaseCreditHold(claimed, {
            users: userRepository,
            organizations: organizationRepository,
          });
        }
        return claimed;
      });
      if (!hold) {
        result.alreadyClaimed++;
        continue;
      }
      result.reclaimed++;
      result.reclaimedCredits += hold.reservedCredits;
      logger.warn('[creditHoldSweep] refunded expired credit hold', {
        holdId: hold.id,
        ownerId: hold.ownerId,
        ownerType: hold.ownerType,
        featureLabel: hold.featureLabel,
        reservedCredits: hold.reservedCredits,
        expiresAt: hold.expiresAt.toISOString(),
      });
    } catch (err) {
      result.failed++;
      logger.error('[creditHoldSweep] expired credit hold refund failed - retried next run', {
        holdId: candidate.id,
        ownerId: candidate.ownerId,
        ownerType: candidate.ownerType,
        reservedCredits: candidate.reservedCredits,
        err,
      });
    }
  }

  if (emitMetrics) {
    // Emitted every run, zero included, so a missing datapoint means the sweep itself stopped.
    const dimensions = { Stage: Resource.App.stage };
    await putMetrics(CLOUDWATCH_NAMESPACE, [
      { name: 'ExpiredHoldsReclaimed', value: result.reclaimed, dimensions, unit: StandardUnit.Count },
      { name: 'ReclaimedCredits', value: result.reclaimedCredits, dimensions, unit: StandardUnit.Count },
      { name: 'ExpiredHoldRefundFailures', value: result.failed, dimensions, unit: StandardUnit.Count },
    ]);
  }

  logger.info('[creditHoldSweep] sweep complete', { ...result, capped: expired.length === CREDIT_HOLD_SWEEP_LIMIT });
  return result;
}

export async function handler(): Promise<CreditHoldSweepResult> {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runCreditHoldSweep();
}
