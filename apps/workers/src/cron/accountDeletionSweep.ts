/**
 * Hard-deletes the accounts whose self-serve deletion grace period has passed, oldest first, through
 * completeAccountDeletion (packages/server-utils/src/users/completeAccountDeletion.ts).
 * Schedule: daily (infra/cron.ts accountDeletionSweep). Self-host twin: apps/workers/src/selfhost/accountDeletionSweep.ts.
 */
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { ACCOUNT_DELETION_DEADLINE_ALERT_DAYS } from '@bike4mind/common';
import { connectDB, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import {
  completeAccountDeletion,
  type AccountDeletionSkipReason,
} from '@bike4mind/server-utils/users/completeAccountDeletion';
import {
  drainDeletionNotices,
  type DeletionNoticeDrainResult,
} from '@bike4mind/server-utils/users/accountDeletionNotice';
import { erasureRegistry } from '@bike4mind/server-utils/dataSubject/erasureRegistry';

const sweepLogger = new Logger({ metadata: { service: 'accountDeletionSweep' } });

// Each account is a full hard delete with provider revokes, so a run stays well inside the Lambda
// timeout; a larger backlog drains over the following days.
const DEFAULT_BATCH_SIZE = 200;

// Alarm: infra/alarms.ts accountDeletionDeadline; runbook: infra/account-deletion-deadline-alarm.md.
const CLOUDWATCH_NAMESPACE = 'Lumina5/AccountDeletion';
const DAY_MS = 24 * 60 * 60 * 1000;

export type AccountDeletionSweepResult = Record<AccountDeletionSkipReason, number> & {
  deleted: number;
  failed: number;
  /** Open deletion requests at least ACCOUNT_DELETION_DEADLINE_ALERT_DAYS old, counted before the purge. */
  overdue: number;
  notices: DeletionNoticeDrainResult;
};

/**
 * Idempotent per account: each is re-checked before its delete, and a deleted account is never listed
 * again, so the next run is the retry. One account's failure does not stop the others.
 */
export async function runAccountDeletionSweep(
  options: { logger?: Logger; batchSize?: number; now?: Date; stage?: string; emitMetrics?: boolean } = {}
): Promise<AccountDeletionSweepResult> {
  const logger = options.logger ?? sweepLogger;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = options.now ?? new Date();

  // Counted and reported first, so a run that later throws has still said how many are overdue.
  const overdue = await userRepository.countOverdueDeletionRequests(
    new Date(now.getTime() - ACCOUNT_DELETION_DEADLINE_ALERT_DAYS * DAY_MS)
  );
  if (options.emitMetrics ?? true) {
    await emitMetric(
      CLOUDWATCH_NAMESPACE,
      'OverdueDeletionRequests',
      overdue,
      { Stage: options.stage ?? Resource.App.stage },
      StandardUnit.Count
    );
  }

  // A notice failure never fails the run: the next run is its retry.
  const notices = await drainDeletionNotices({ logger, now }).catch((error: unknown) => {
    logger.error('[AccountDeletionSweep] Failed to drain deletion notices:', error);
    return { sent: 0, failed: 0, abandoned: 0 };
  });

  const counts: AccountDeletionSweepResult = {
    deleted: 0,
    not_due: 0,
    not_found: 0,
    busy: 0,
    failed: 0,
    overdue,
    notices,
  };
  for (const userId of await userRepository.findDeletionDueUserIds(now, batchSize)) {
    try {
      const outcome = await completeAccountDeletion(userId, { logger, now, erasureRegistry });
      counts[outcome.deleted ? 'deleted' : outcome.reason]++;
    } catch (error) {
      counts.failed++;
      logger.error(`[AccountDeletionSweep] Failed to delete user ${userId}:`, error);
    }
  }

  const { sent, failed: noticesFailed, abandoned } = notices;
  if (
    counts.deleted +
      counts.not_due +
      counts.not_found +
      counts.busy +
      counts.failed +
      overdue +
      sent +
      noticesFailed +
      abandoned >
    0
  ) {
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
