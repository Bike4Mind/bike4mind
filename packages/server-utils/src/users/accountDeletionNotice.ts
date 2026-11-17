import { ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS, accountDeletionNoticeRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { sendAccountDeletionCompleteEmail } from './accountDeletionEmail';

type NoticeLogger = Pick<Logger, 'warn' | 'error'>;
export type NoticeOutcome = 'sent' | 'failed' | 'abandoned';
export type DeletionNoticeDrainResult = Record<NoticeOutcome, number>;

/** One failed send right after the delete, then one per daily sweep. */
export const ACCOUNT_DELETION_NOTICE_MAX_ATTEMPTS = 5;
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
    // PutEvents reports a rejected entry as a normal response, not a throw.
    const sent = await sendAccountDeletionCompleteEmail(email);
    if (sent && sent.FailedEntryCount) throw Object.assign(new Error('EntryRejected'), { name: 'EntryRejected' });
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown';
    let attempts: number | null = null;
    try {
      attempts = await accountDeletionNoticeRepository.markFailed(
        idHash,
        new Date(now.getTime() + ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS)
      );
    } catch {
      logger.warn(`Could not record a failed deletion-complete send; it will be retried (${reason})`);
      return 'failed';
    }
    // Null: gone already, a concurrent send succeeded, so there is nothing left to retry.
    if (attempts === null) return 'failed';
    if (attempts >= maxAttempts) {
      try {
        await accountDeletionNoticeRepository.remove(idHash);
        logger.error(`Gave up sending a deletion-complete email after ${attempts} attempts (${reason})`);
        return 'abandoned';
      } catch {
        logger.error(`Could not remove a deletion-complete notice after ${attempts} attempts (${reason})`);
        return 'failed';
      }
    }
    logger.warn(`Failed to send a deletion-complete email; it will be retried (${reason})`);
    return 'failed';
  }
  try {
    await accountDeletionNoticeRepository.remove(idHash);
  } catch {
    // Sent but not cleared: it stays due, so the next sweep sends again until a remove succeeds.
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
