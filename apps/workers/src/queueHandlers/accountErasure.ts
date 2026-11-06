import { z } from 'zod';
import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { completeAccountDeletion } from '@server/users/completeAccountDeletion';

const AccountErasurePayload = z.object({ userId: z.string().min(1) });

/**
 * Admin data subject erasure: runs the account purge for one user as soon as it can instead of waiting for the daily
 * sweep (cron/accountDeletionSweep.ts). The purge is idempotent and leased, so a retry is safe and the sweep
 * is the backstop. Errors are rethrown for SQS to retry; a malformed payload is dropped, since a retry
 * cannot fix it.
 */
export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  for (const record of event.Records) {
    let body: unknown;
    try {
      body = JSON.parse(record.body);
    } catch {
      logger.error('Account erasure dropped: message body is not valid JSON');
      continue;
    }
    const payload = AccountErasurePayload.safeParse(body);
    if (!payload.success) {
      logger.error('Account erasure dropped: invalid payload', { issues: payload.error.issues.map(i => i.path) });
      continue;
    }

    const { userId } = payload.data;
    logger.updateMetadata({ userId });
    const outcome = await completeAccountDeletion(userId, { logger });
    if (!outcome.deleted && outcome.reason === 'busy') {
      // A live purge or data export holds the account; SQS redelivers after the visibility timeout.
      throw new Error(`Account erasure of user ${userId} deferred: the account is busy`);
    }
    if (outcome.deleted) {
      logger.info('Account erasure completed: account deleted');
    } else {
      logger.info(`Account erasure skipped: ${outcome.reason}`);
    }
  }
});
