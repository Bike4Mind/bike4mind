import { accountDeletionNoticeRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { sendAccountDeletionCompleteEmail } from './accountDeletionEmail';

type NoticeLogger = Pick<Logger, 'warn' | 'error'>;
export type NoticeOutcome = 'sent' | 'failed' | 'abandoned';
export type DeletionNoticeDrainResult = Record<NoticeOutcome, number>;

/** One failed send right after the delete, then one per daily sweep. */
export const ACCOUNT_DELETION_NOTICE_MAX_ATTEMPTS = 5;
// Short enough that the next daily sweep always finds it due.
const RETRY_DELAY_MS = 60 * 60 * 1000;
const DRAIN_LIMIT = 200;

/**
 * Sends the confirmation for one stored notice. The notice (and so the address) is removed only after
 * the send succeeds, or after the last allowed attempt fails. Never throws: the account is already
 * deleted. Logs carry no address or user id.
 */
export async function sendPendingDeletionNotice(
  idHash: string,
  email: string,
  {
    logger,
    now = new Date(),
    maxAttempts = ACCOUNT_DELETION_NOTICE_MAX_ATTEMPTS,
  }: { logger: NoticeLogger; now?: Date; maxAttempts?: number }
): Promise<NoticeOutcome> {
  try {
    await sendAccountDeletionCompleteEmail(email);
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown';
    try {
      const attempts = await accountDeletionNoticeRepository.markFailed(
        idHash,
        new Date(now.getTime() + RETRY_DELAY_MS)
      );
      if (attempts !== null && attempts >= maxAttempts) {
        await accountDeletionNoticeRepository.remove(idHash);
        logger.error(`Gave up sending a deletion-complete email after ${attempts} attempts (${reason})`);
        return 'abandoned';
      }
    } catch {
      // The notice stays as it was; the next run retries.
    }
    logger.warn(`Failed to send a deletion-complete email; it will be retried (${reason})`);
    return 'failed';
  }
  try {
    await accountDeletionNoticeRepository.remove(idHash);
  } catch {
    // Sent but not cleared: the TTL removes it. A repeat send is better than none.
  }
  return 'sent';
}

/** Retries every due notice once. Counts only; one notice's failure does not stop the others. */
export async function drainDeletionNotices({
  logger,
  now = new Date(),
  limit = DRAIN_LIMIT,
  maxAttempts = ACCOUNT_DELETION_NOTICE_MAX_ATTEMPTS,
}: {
  logger: NoticeLogger;
  now?: Date;
  limit?: number;
  maxAttempts?: number;
}): Promise<DeletionNoticeDrainResult> {
  const result: DeletionNoticeDrainResult = { sent: 0, failed: 0, abandoned: 0 };
  for (const notice of await accountDeletionNoticeRepository.listDue(now, limit)) {
    result[await sendPendingDeletionNotice(notice.idHash, notice.email, { logger, now, maxAttempts })]++;
  }
  return result;
}
