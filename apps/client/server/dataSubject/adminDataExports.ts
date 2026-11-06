import {
  ADMIN_DATA_EXPORT_REQUESTED_ACTION,
  NotFoundError,
  assertCanActOnAdminTarget,
  type AdminDataExportStatus,
  type AdminDataExportSummary,
} from '@bike4mind/common';
import { adminAuditLogRepository, userRepository } from '@bike4mind/database';
import {
  ACCOUNT_DATA_EXPORT_TTL_MS,
  adminDataExportKey,
  isMissingObjectError,
} from '@bike4mind/server-utils/utils/accountDataExport';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';

/**
 * Admin data subject exports have no job table: the strict `user.data_export.requested` audit entry
 * is the request record, and the object under `adminDataExportKey` is the result.
 */

// The worker's retries (two, at a 16-minute visibility timeout: infra/queues.ts) end well inside this.
export const ADMIN_DATA_EXPORT_GIVE_UP_MS = 60 * 60 * 1000;
const LISTED_EXPORTS = 20;

type AdminActor = Parameters<typeof assertCanActOnAdminTarget>[0];

/** The user named by the route, whose data this admin may export: only full admins export an admin's. */
export async function findDataExportTarget(actor: AdminActor, userId: unknown) {
  const user = typeof userId === 'string' && userId ? await userRepository.findById(userId) : null;
  if (!user) throw new NotFoundError('User not found');
  assertCanActOnAdminTarget(actor, user, 'export the data of');
  return {
    user,
    auditTarget: { kind: 'user' as const, id: user.id, displayName: user.email ?? user.username ?? user.id },
  };
}

type ExportStorage = Pick<ReturnType<typeof getFilesStorage>, 'getMetadata'>;

/** When the export object was written, or null while it does not exist. */
export async function readAdminDataExportBuiltAt(
  storage: ExportStorage,
  userId: string,
  exportJobId: string
): Promise<Date | null> {
  try {
    return (await storage.getMetadata(adminDataExportKey(userId, exportJobId))).lastModified ?? null;
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

export function adminDataExportStatus(builtAt: Date | null, requestedAt: Date, now: number): AdminDataExportStatus {
  if (!builtAt) {
    return now - requestedAt.getTime() > ADMIN_DATA_EXPORT_GIVE_UP_MS ? { state: 'failed' } : { state: 'building' };
  }
  const expiresAt = builtAt.getTime() + ACCOUNT_DATA_EXPORT_TTL_MS;
  return now >= expiresAt
    ? { state: 'expired', builtAt: builtAt.toISOString() }
    : { state: 'ready', builtAt: builtAt.toISOString(), expiresAt: new Date(expiresAt).toISOString() };
}

/** Recent requests for this user, newest first, each with whether its export can be downloaded. */
export async function listAdminDataExports(
  userId: string,
  storage: ExportStorage = getFilesStorage(),
  now = Date.now()
): Promise<AdminDataExportSummary[]> {
  const { entries } = await adminAuditLogRepository.list(
    {
      action: ADMIN_DATA_EXPORT_REQUESTED_ACTION,
      targetKind: 'user',
      targetId: userId,
      from: new Date(now - ACCOUNT_DATA_EXPORT_TTL_MS - ADMIN_DATA_EXPORT_GIVE_UP_MS).toISOString(),
    },
    { limit: LISTED_EXPORTS }
  );
  return Promise.all(
    entries.flatMap(entry => {
      const exportJobId = entry.details?.exportJobId;
      if (typeof exportJobId !== 'string') return [];
      return [
        (async (): Promise<AdminDataExportSummary> => ({
          exportJobId,
          requestedAt: entry.occurredAt.toISOString(),
          requestedBy: entry.actor.name,
          reason: entry.reason ?? null,
          status: adminDataExportStatus(
            await readAdminDataExportBuiltAt(storage, userId, exportJobId),
            entry.occurredAt,
            now
          ),
        }))(),
      ];
    })
  );
}
