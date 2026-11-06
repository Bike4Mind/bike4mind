/**
 * Hard-deletes the accounts whose self-serve deletion grace period has passed, oldest first, through
 * completeAccountDeletion (apps/client/server/users/completeAccountDeletion.ts).
 * Schedule: daily (infra/cron.ts accountDeletionSweep). Self-host twin: apps/workers/src/selfhost/accountDeletionSweep.ts.
 */
import { connectDB, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { completeAccountDeletion, type AccountDeletionSkipReason } from '@server/users/completeAccountDeletion';

const sweepLogger = new Logger({ metadata: { service: 'accountDeletionSweep' } });

// Each account is a full hard delete with provider revokes, so a run stays well inside the Lambda
// timeout; a larger backlog drains over the following days.
const DEFAULT_BATCH_SIZE = 200;

export type AccountDeletionSweepResult = Record<AccountDeletionSkipReason, number> & {
  deleted: number;
  failed: number;
};

/**
 * Idempotent per account: each is re-checked before its delete, and a deleted account is never listed
 * again, so the next run is the retry. One account's failure does not stop the others.
 */
export async function runAccountDeletionSweep(
  options: { logger?: Logger; batchSize?: number; now?: Date } = {}
): Promise<AccountDeletionSweepResult> {
  const logger = options.logger ?? sweepLogger;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = options.now ?? new Date();

  const counts: AccountDeletionSweepResult = { deleted: 0, not_due: 0, not_found: 0, busy: 0, failed: 0 };
  for (const userId of await userRepository.findDeletionDueUserIds(now, batchSize)) {
    try {
      const outcome = await completeAccountDeletion(userId, { logger, now });
      counts[outcome.deleted ? 'deleted' : outcome.reason]++;
    } catch (error) {
      counts.failed++;
      logger.error(`[AccountDeletionSweep] Failed to delete user ${userId}:`, error);
    }
  }

  if (counts.deleted + counts.not_due + counts.not_found + counts.busy + counts.failed > 0) {
    logger.info('[AccountDeletionSweep] done', counts);
  }
  return counts;
}

export const assertAccountDeletionSweepSucceeded = (result: AccountDeletionSweepResult): void => {
  if (result.failed > 0) throw new Error(`[AccountDeletionSweep] ${result.failed} account(s) failed to delete`);
};

export const handler = async () => {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  const result = await runAccountDeletionSweep();
  // A failed account is retried by the next run; throwing sends this one to the DLQ so it is seen.
  assertAccountDeletionSweepSucceeded(result);
  return result;
};
