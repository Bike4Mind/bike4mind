import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { accountDeletionCutoff } from '@bike4mind/common';
import { connectDB, userRepository } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { purgeExpiredAccount, type ExpiredAccountOutcome } from '@server/accountDeletion/purgeExpiredAccount';
import { Resource } from 'sst';

const sweepLogger = new Logger({ metadata: { service: 'accountDeletionSweep' } });

// Accounts per run. Each is a full hard delete with provider revocations, so the daily run stays well
// inside the Lambda timeout; a backlog drains over the following days.
const DEFAULT_BATCH_SIZE = 200;

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

export async function handler(event: never, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
    const result = await runAccountDeletionSweep({ logger });
    // A failed account is retried by tomorrow's run; throwing sends this run to the DLQ so it is seen.
    if (result.failed > 0) throw new Error(`[AccountDeletionSweep] ${result.failed} account(s) failed to delete`);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    logger.error('[AccountDeletionSweep] Failed:', error);
    throw error;
  }
}

/**
 * Hard-deletes the accounts whose self-service deletion grace period has passed. Idempotent: each
 * account is re-checked before its delete, and a deleted account is never listed again. One account's
 * failure does not stop the others. Exported without the DB connect so the self-host worker can call it.
 */
export async function runAccountDeletionSweep(options: { logger?: Logger; batchSize?: number; now?: Date } = {}) {
  const logger = options.logger ?? sweepLogger;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Invalid account deletion batch size');
  const cutoff = accountDeletionCutoff(options.now ?? new Date());

  const counts: Record<ExpiredAccountOutcome, number> & { failed: number } = {
    deleted: 0,
    not_due: 0,
    org_has_members: 0,
    failed: 0,
  };
  const userIds = await userRepository.findDeletionDueUserIds(cutoff, batchSize);
  for (const userId of userIds) {
    try {
      counts[await purgeExpiredAccount(userId, { cutoff, logger })]++;
    } catch (error) {
      counts.failed++;
      logger.error(`[AccountDeletionSweep] Failed to delete user ${userId}:`, error);
    }
  }

  logger.log(
    `[AccountDeletionSweep] deleted ${counts.deleted}, skipped ${counts.not_due + counts.org_has_members}, failed ${counts.failed} (cutoff: ${cutoff.toISOString()})`
  );
  return { ...counts, cutoff: cutoff.toISOString() };
}
