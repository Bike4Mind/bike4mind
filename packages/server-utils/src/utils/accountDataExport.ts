/**
 * Shared between the request/download routes (apps/client/pages/api/users/me/data-export and
 * apps/client/pages/api/admin/users/[userId]/data-export) and the builder (apps/workers/src/queueHandlers/accountDataExport.ts).
 */

/** How long a built export stays downloadable. The fabFileBucket `exports/` lifecycle rule deletes it after. */
export const ACCOUNT_DATA_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export const ACCOUNT_DATA_EXPORT_FILENAME = 'account-data.zip';

// Must stay under `exports/` so the fabFileBucket expire-notebook-exports rule (infra/buckets.ts) reaps it.
export const accountDataExportKey = (userId: string, exportJobId: string): string =>
  `exports/account-data/${encodeURIComponent(userId)}/${encodeURIComponent(exportJobId)}/${ACCOUNT_DATA_EXPORT_FILENAME}`;

export const ADMIN_DATA_EXPORT_FILENAME = 'data-subject-export.zip';

// An admin-requested export of the same person. It stays under that person's account-data prefix so
// the account purge's prefix delete (apps/client/server/users/purgeAccountFiles.ts) removes it too,
// and the literal `admin` segment can never collide with a self-serve export's UUID job id.
export const adminDataExportKey = (userId: string, exportJobId: string): string =>
  `exports/account-data/${encodeURIComponent(userId)}/admin/${encodeURIComponent(exportJobId)}/${ADMIN_DATA_EXPORT_FILENAME}`;

export const isMissingObjectError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey');
