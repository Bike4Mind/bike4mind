import { randomUUID } from 'crypto';
import { buildContentDisposition } from '@bike4mind/utils/contentDisposition';
import { getFilesStorage } from '@server/utils/storage';

/**
 * Key prefix for staged audit-log CSV exports. It sits under `exports/`, which the fab-file bucket's
 * `expire-notebook-exports` lifecycle rule (infra/buckets.ts, compose.selfhost.yaml) reaps after a day
 * and which is already reserved from FabFile keys and skipped by the object-created handlers
 * (untrackedFabFileKey.ts). Must stay under that prefix: the CSVs hold actor emails and IPs.
 * Guarded by infra/__tests__/fabFileBucketLifecycle.test.ts.
 */
export const ADMIN_AUDIT_EXPORT_PREFIX = 'exports/admin-audit-log/';

/** Lifetime of a staged export's signed URL, in seconds. Well inside the 1-day lifecycle expiry. */
export const ADMIN_AUDIT_EXPORT_URL_TTL_SECONDS = 15 * 60;

/**
 * Uploads a rendered CSV and returns a signed GET URL that downloads it as `fileName`. Staged rather
 * than returned inline because a full export is far over the ~6MB Lambda response cap
 * (generatedAudioDelivery.ts has the same constraint). Throws on a storage failure.
 */
export async function stageAdminAuditExport(csv: string, fileName: string): Promise<string> {
  const key = `${ADMIN_AUDIT_EXPORT_PREFIX}${randomUUID()}/${fileName}`;
  const storage = getFilesStorage();
  await storage.upload(Buffer.from(csv, 'utf8'), key, { ContentType: 'text/csv; charset=utf-8' });
  return storage.getSignedUrl(key, 'get', {
    expiresIn: ADMIN_AUDIT_EXPORT_URL_TTL_SECONDS,
    ResponseContentDisposition: buildContentDisposition(fileName),
  });
}
