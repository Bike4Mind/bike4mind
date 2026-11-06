import type { AdminAuditAction } from './adminAuditCatalogue';

/** One admin-requested data subject export of a user, as the admin profile lists it. */
export type AdminDataExportStatus =
  | { state: 'building' }
  | { state: 'ready'; builtAt: string; expiresAt: string }
  | { state: 'expired'; builtAt: string }
  /** Not built long after the request: the worker gave up and the request should be made again. */
  | { state: 'failed' };

export type AdminDataExportSummary = {
  exportJobId: string;
  requestedAt: string;
  requestedBy: string;
  reason: string | null;
  status: AdminDataExportStatus;
};

export type AdminDataExportDownload = { url: string; filename: string; expiresAt: string };

export const ADMIN_DATA_EXPORT_REQUESTED_ACTION = 'user.data_export.requested' satisfies AdminAuditAction;
export const ADMIN_DATA_EXPORT_DOWNLOADED_ACTION = 'user.data_export.downloaded' satisfies AdminAuditAction;
