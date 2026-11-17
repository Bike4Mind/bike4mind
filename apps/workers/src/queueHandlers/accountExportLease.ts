import { randomUUID } from 'crypto';
import { User } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { MAX_ACCOUNT_EXPORT_LEASE_WAITS } from '@bike4mind/server-utils/utils/accountDataExport';
import type { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';

export const LEASE_WAIT_DELAY_SECONDS = 120;
export const MAX_LEASE_WAITS = MAX_ACCOUNT_EXPORT_LEASE_WAITS;
export const LEASE_WAITS_PER_REDELIVERY = 8;
export const UPLOAD_RESERVE_MS = 5 * 60 * 1000;
const EXPORT_LEASE_MS = 20 * 60 * 1000;

type ExportSubject = {
  deletion?: { purgeStartedAt?: Date | null; scheduledFor?: Date | null } | null;
};

export const accountExportDeletionDue = (account: ExportSubject | null | undefined): boolean =>
  !!account?.deletion?.purgeStartedAt ||
  (!!account?.deletion?.scheduledFor && new Date(account.deletion.scheduledFor).getTime() <= Date.now());

/** A redelivery already waited out a queue visibility timeout; count it toward the same wait cap. */
export const nextExportLeaseWaits = (leaseWaits: number, receiveCount: number): number =>
  leaseWaits + 1 + (receiveCount - 1) * LEASE_WAITS_PER_REDELIVERY;

type UploadOptions = {
  storage: Pick<ReturnType<typeof getFilesStorage>, 'uploadFile' | 'deletePermanently'>;
  localPath: string;
  key: string;
  remainingMs: () => number;
  logger: Pick<Logger, 'error'>;
};

export type AccountExportLease = {
  deliveryEmail: string | null | undefined;
  assertActive: () => Promise<void>;
  upload: (options: UploadOptions) => Promise<void>;
  release: () => Promise<void>;
};

/** The same concrete User fence used by self/admin exports and the account purge's atomic claim. */
export async function claimAccountExportLease(
  userId: string,
  exportJobId: string,
  label = 'Account data export'
): Promise<AccountExportLease | null> {
  const now = new Date();
  const leaseId = randomUUID();
  const admissionFilter = {
    _id: userId,
    deletedAt: null,
    'deletion.purgeStartedAt': null,
    'accountFilePurge.startedAt': null,
    $and: [
      { $or: [{ 'accountFilePurge.leaseExpiresAt': null }, { 'accountFilePurge.leaseExpiresAt': { $lte: now } }] },
    ],
    $or: [{ 'deletion.scheduledFor': null }, { 'deletion.scheduledFor': { $gt: now } }],
  };
  const claimed = await User.findOneAndUpdate(
    {
      ...admissionFilter,
      $and: [
        ...admissionFilter.$and,
        { $or: [{ 'accountDataExportLease.expiresAt': null }, { 'accountDataExportLease.expiresAt': { $lte: now } }] },
      ],
    },
    {
      $set: {
        accountDataExportLease: {
          id: leaseId,
          jobId: exportJobId,
          expiresAt: new Date(now.getTime() + EXPORT_LEASE_MS),
        },
      },
    },
    { new: true, projection: { email: 1 } }
  ).lean<{ email?: string | null }>();
  if (!claimed) return null;

  const leaseFilter = () => ({
    ...admissionFilter,
    $and: [
      {
        $or: [{ 'accountFilePurge.leaseExpiresAt': null }, { 'accountFilePurge.leaseExpiresAt': { $lte: new Date() } }],
      },
    ],
    $or: [{ 'deletion.scheduledFor': null }, { 'deletion.scheduledFor': { $gt: new Date() } }],
    'accountDataExportLease.id': leaseId,
    'accountDataExportLease.expiresAt': { $gt: new Date() },
  });
  const hasLease = async () => !!(await User.exists(leaseFilter()));
  const assertActive = async () => {
    if (!(await hasLease())) throw new Error(`${label} lease lost or account deletion is due`);
  };
  let releaseLease = true;

  return {
    deliveryEmail: claimed.email,
    assertActive,
    upload: async ({ storage, localPath, key, remainingMs, logger }) => {
      await assertActive();
      const uploadTimeoutMs = Math.min(UPLOAD_RESERVE_MS, remainingMs() - 1000);
      if (uploadTimeoutMs <= 0) throw new Error(`No remaining time to upload the ${label.toLowerCase()}`);
      const renewed = await User.updateOne(leaseFilter(), {
        $set: { 'accountDataExportLease.expiresAt': new Date(Date.now() + EXPORT_LEASE_MS) },
      });
      if (renewed.matchedCount !== 1) throw new Error(`${label} lease lost before upload`);
      try {
        await storage.uploadFile(
          localPath,
          key,
          { ContentType: 'application/zip' },
          AbortSignal.timeout(uploadTimeoutMs)
        );
      } catch (error) {
        // An unsuccessful response does not prove the remote PUT cannot still commit.
        // Keep the renewed fence until expiry even after strict exact-key cleanup succeeds.
        releaseLease = false;
        try {
          await storage.deletePermanently(key);
        } catch (cleanupError) {
          logger.error(`${label}: failed to reconcile an ambiguous upload`, { key, cleanupError });
        }
        throw error;
      }
      if (!(await hasLease())) {
        await storage.deletePermanently(key);
        throw new Error(`${label} lease lost after upload`);
      }
    },
    release: async () => {
      if (releaseLease)
        await User.updateOne(
          { _id: userId, 'accountDataExportLease.id': leaseId },
          { $unset: { accountDataExportLease: 1 } }
        );
    },
  };
}
