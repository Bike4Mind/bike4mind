import {
  ADMIN_DATA_EXPORT_DENIED_ACTION,
  ADMIN_DATA_EXPORT_FAILED_ACTION,
  ADMIN_DATA_EXPORT_REQUESTED_ACTION,
  NotFoundError,
  type AdminAuditAction,
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
import { denySelfAdminAction, isSelfOrImpersonator } from '@bike4mind/server-utils/utils/adminAudit';

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

type DataExportTarget = Awaited<ReturnType<typeof findDataExportTarget>>;

/**
 * No admin exports their own account (or the one they are impersonating) through the admin tool:
 * records a `user.data_export.denied` entry and throws a 403, as the sibling admin user routes do.
 * Their own data goes through the self-serve export.
 */
export async function denySelfDataExport(
  req: Parameters<typeof denySelfAdminAction>[0],
  { user, auditTarget }: DataExportTarget,
  attempted: Extract<AdminAuditAction, `user.data_export.${string}`>
): Promise<void> {
  // Fails closed: a request with no actor is denied too (adminApi always sets one).
  if (req.user && !isSelfOrImpersonator(req.user, user.id)) return;
  await denySelfAdminAction(req, { action: ADMIN_DATA_EXPORT_DENIED_ACTION, attempted, target: auditTarget });
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
  const recent = (action: AdminAuditAction) =>
    adminAuditLogRepository.list(
      {
        action,
        targetKind: 'user',
        targetId: userId,
        from: new Date(now - ACCOUNT_DATA_EXPORT_TTL_MS - ADMIN_DATA_EXPORT_GIVE_UP_MS).toISOString(),
      },
      { limit: LISTED_EXPORTS }
    );
  const [requested, failed] = await Promise.all([
    recent(ADMIN_DATA_EXPORT_REQUESTED_ACTION),
    recent(ADMIN_DATA_EXPORT_FAILED_ACTION),
  ]);
  const neverQueued = new Set(failed.entries.flatMap(entry => exportJobIdOf(entry) ?? []));
  return Promise.all(
    requested.entries.flatMap(entry => {
      const exportJobId = exportJobIdOf(entry);
      if (!exportJobId) return [];
      return [
        (async (): Promise<AdminDataExportSummary> => ({
          exportJobId,
          requestedAt: entry.occurredAt.toISOString(),
          requestedBy: entry.actor.name,
          reason: entry.reason ?? null,
          status: neverQueued.has(exportJobId)
            ? { state: 'failed' }
            : adminDataExportStatus(
                await readAdminDataExportBuiltAt(storage, userId, exportJobId),
                entry.occurredAt,
                now
              ),
        }))(),
      ];
    })
  );
}

const exportJobIdOf = (entry: { details?: Record<string, unknown> | null }): string | undefined => {
  const exportJobId = entry.details?.exportJobId;
  return typeof exportJobId === 'string' ? exportJobId : undefined;
};
