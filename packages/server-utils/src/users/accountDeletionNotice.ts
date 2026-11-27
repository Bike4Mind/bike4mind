import {
  ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS,
  accountDeletionNoticeRepository,
  type ClaimedAccountDeletionNotice,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { sendAccountDeletionCompleteEmail } from './accountDeletionEmail';

type NoticeLogger = Pick<Logger, 'warn' | 'error'>;
export type NoticeOutcome = 'sent' | 'failed' | 'abandoned';
export type DeletionNoticeDrainResult = Record<NoticeOutcome, number>;
type NoticeOptions = { logger: NoticeLogger; now?: Date; maxAttempts?: number };

/** One failed send right after the delete, then one per daily sweep. */
export const ACCOUNT_DELETION_NOTICE_MAX_ATTEMPTS = 5;
const DRAIN_LIMIT = 200;

async function sendClaimedNotice(
  notice: ClaimedAccountDeletionNotice,
  { logger, now = new Date(), maxAttempts = ACCOUNT_DELETION_NOTICE_MAX_ATTEMPTS }: NoticeOptions
): Promise<NoticeOutcome> {
  const { idHash, leaseToken } = notice;
  // Recover a crash between the final failed attempt and its cleanup without sending a sixth email.
  if (notice.attempts >= maxAttempts) {
    try {
      await accountDeletionNoticeRepository.remove(idHash, leaseToken);
      return 'abandoned';
    } catch {
      logger.error('Could not remove an exhausted deletion-complete notice');
      return 'failed';
    }
  }
  try {
    // PutEvents reports a rejected entry as a normal response, not a throw.
    const sent = await sendAccountDeletionCompleteEmail(notice.email);
    if (sent && sent.FailedEntryCount) throw Object.assign(new Error('EntryRejected'), { name: 'EntryRejected' });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'EntryRejected' ? 'EntryRejected' : 'delivery failure';
    let attempts: number | null;
    try {
      attempts = await accountDeletionNoticeRepository.markFailed(
        idHash,
        leaseToken,
        new Date(Math.max(now.getTime(), Date.now()) + ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS)
      );
    } catch {
      logger.warn(`Could not record a failed deletion-complete send; it will be retried (${reason})`);
      return 'failed';
    }
    // A successor owns the row or it is already gone; never change that successor's state.
    if (attempts === null) return 'failed';
    if (attempts >= maxAttempts) {
      try {
        await accountDeletionNoticeRepository.remove(idHash, leaseToken);
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
    await accountDeletionNoticeRepository.remove(idHash, leaseToken);
  } catch {
    logger.warn('Deletion-complete email accepted but notice cleanup failed; it may be retried');
  }
  return 'sent';
}

/**
 * Claims and sends the stored recipient. Null means no work was claimed. Never throws after deletion.
 * Claims prevent ordinary overlap; transport acceptance followed by a crash still permits a later retry.
 */
export async function sendPendingDeletionNotice(idHash: string, options: NoticeOptions): Promise<NoticeOutcome | null> {
  let notice: ClaimedAccountDeletionNotice | null;
  try {
    notice = await accountDeletionNoticeRepository.claimDue(idHash, options.now ?? new Date());
  } catch {
    options.logger.warn('Could not claim a deletion-complete notice; it will be retried');
    return null;
  }
  return notice ? sendClaimedNotice(notice, options) : null;
}

/** Claims each available due notice once. Counts only work claimed by this invocation. */
export async function drainDeletionNotices({
  logger,
  now = new Date(),
  limit = DRAIN_LIMIT,
  maxAttempts = ACCOUNT_DELETION_NOTICE_MAX_ATTEMPTS,
}: NoticeOptions & { limit?: number }): Promise<DeletionNoticeDrainResult> {
  const result: DeletionNoticeDrainResult = { sent: 0, failed: 0, abandoned: 0 };
  const claimedIdHashes: string[] = [];
  for (let claimed = 0; claimed < Math.min(limit, DRAIN_LIMIT); claimed++) {
    let notice: ClaimedAccountDeletionNotice | null;
    try {
      // Lease time is fresh for every claim, independently of the run's fixed due cutoff.
      notice = await accountDeletionNoticeRepository.claimNextDue(now, new Date(), claimedIdHashes);
    } catch {
      logger.warn('Could not claim deletion-complete notices; they will be retried');
      break;
    }
    if (!notice) break;
    // Retain the original once-per-drain cadence even if a send outlives its lease.
    claimedIdHashes.push(notice.idHash);
    result[await sendClaimedNotice(notice, { logger, now, maxAttempts })]++;
  }
  return result;
}
