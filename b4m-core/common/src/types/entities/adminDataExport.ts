import type { AdminAuditAction } from './adminAuditCatalogue';

/** One admin-requested data subject export of a user, as the admin profile lists it. */
export type AdminDataExportStatus =
  | { state: 'building' }
  | { state: 'ready'; builtAt: string; expiresAt: string }
  | { state: 'expired'; builtAt: string }
  /** Never queued, skipped by the worker (`reason`), or not built long after the request. */
  | { state: 'failed'; reason?: AdminDataExportSkipReason };

/** Why the export worker skipped an admin export, recorded on its `user.data_export.failed` entry. */
export const ADMIN_DATA_EXPORT_SKIP_REASONS = ['account_gone', 'deletion_due', 'deletion_won_admission'] as const;
export type AdminDataExportSkipReason = (typeof ADMIN_DATA_EXPORT_SKIP_REASONS)[number];

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
export const ADMIN_DATA_EXPORT_FAILED_ACTION = 'user.data_export.failed' satisfies AdminAuditAction;
export const ADMIN_DATA_EXPORT_DENIED_ACTION = 'user.data_export.denied' satisfies AdminAuditAction;
