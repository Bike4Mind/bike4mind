import {
  ADMIN_DATA_EXPORT_DENIED_ACTION,
  ADMIN_DATA_EXPORT_FAILED_ACTION,
  ADMIN_DATA_EXPORT_REQUESTED_ACTION,
  ADMIN_DATA_EXPORT_SKIP_REASONS,
  NotFoundError,
  type AdminAuditAction,
  assertCanActOnAdminTarget,
  type AdminDataExportStatus,
  type AdminDataExportSkipReason,
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

// Past the latest a job that waits out another export's lease can still succeed: 30 minutes of re-sends
// (apps/workers/src/queueHandlers/accountDataExport.ts, which charges a re-sent redelivery as waits), every
// redelivery of one copy, then one full run. That is 61 minutes on AWS (infra/queues.ts); on the self-host
// runner (apps/workers/src/selfhost/registerRedrivenQueue.ts) it is 70 only while each run keeps to its
// cooperative budget, so an overrunning run can still be building here when listed as failed.
// accountDataExport.test.ts checks both sums.
export const ADMIN_DATA_EXPORT_GIVE_UP_MS = 80 * 60 * 1000;
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
  // Written by the route when the job could not be queued, or by the worker with a skipReason.
  const failedJobs = new Map(
    failed.entries.flatMap(entry => {
      const exportJobId = exportJobIdOf(entry);
      return exportJobId ? [[exportJobId, skipReasonOf(entry)] as const] : [];
    })
  );
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
          status: failedJobs.has(exportJobId)
            ? failedStatus(failedJobs.get(exportJobId))
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

const skipReasonOf = (entry: { details?: Record<string, unknown> | null }): AdminDataExportSkipReason | undefined =>
  ADMIN_DATA_EXPORT_SKIP_REASONS.find(reason => reason === entry.details?.skipReason);

const failedStatus = (reason: AdminDataExportSkipReason | undefined): AdminDataExportStatus =>
  reason ? { state: 'failed', reason } : { state: 'failed' };
