import { adminAuditLogRepository } from '@bike4mind/database';
import {
  ApiKeyScope,
  AUDIT_EXPORT_MAX_ROWS,
  type AuditEntry,
  type AuditExportResult,
  type AuditLogCursor,
  type AuditLogFilters,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { toCsv } from '@client/app/utils/csv';
import { adminApi } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { stageAdminAuditExport } from '@server/utils/adminAuditExportStorage';
import { parseAuditExportQuery } from '@server/utils/adminAuditQuery';
import { InternalServerError } from '@bike4mind/server-utils/utils/errors';

const EXPORT_PAGE_SIZE = 1000;

const CSV_HEADER = [
  'occurredAt',
  'action',
  'category',
  'severity',
  'actorName',
  'actorEmail',
  'actorUserId',
  'impersonatedUserId',
  'targetKind',
  'targetId',
  'targetName',
  'summary',
  'reason',
  'source',
  'ip',
  'requestId',
  'entryId',
];

const toCsvRow = (entry: AuditEntry): unknown[] => [
  entry.occurredAt.toISOString(),
  entry.action,
  entry.category,
  entry.severity,
  entry.actor.name,
  entry.actor.email,
  entry.actor.userId,
  entry.actor.impersonatedUserId,
  entry.target.kind,
  entry.target.id,
  entry.target.displayName,
  entry.summary,
  entry.reason,
  entry.context.source,
  entry.context.ip,
  entry.context.requestId,
  entry.id,
];

/** Pages until the repository runs dry or the row cap is hit; `truncated` means rows were left behind. */
const collectEntries = async (filters: AuditLogFilters): Promise<{ entries: AuditEntry[]; truncated: boolean }> => {
  const entries: AuditEntry[] = [];
  let cursor: AuditLogCursor | undefined;

  while (entries.length < AUDIT_EXPORT_MAX_ROWS) {
    const limit = Math.min(EXPORT_PAGE_SIZE, AUDIT_EXPORT_MAX_ROWS - entries.length);
    const page = await adminAuditLogRepository.list(filters, { limit, cursor });
    entries.push(...page.entries);
    if (!page.nextCursor) return { entries, truncated: false };
    cursor = page.nextCursor;
  }
  return { entries, truncated: true };
};

const stageExportOrThrow = async (csv: string, fileName: string, rowCount: number): Promise<string> => {
  try {
    return await stageAdminAuditExport(csv, fileName);
  } catch (error) {
    Logger.error('[Admin] Failed to stage admin audit log export', { error, rowCount });
    throw new InternalServerError('Failed to prepare the audit log export. Please retry.');
  }
};

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const filters = parseAuditExportQuery(req.query);

  const { entries, truncated } = await collectEntries(filters);
  const csv = toCsv([CSV_HEADER, ...entries.map(toCsvRow)]);

  const rowCount = entries.length;
  const fileName = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;

  const url = await stageExportOrThrow(csv, fileName, rowCount);

  // Recorded only once the file exists, so the trail never claims an export nobody could download.
  await recordAdminActionFromRequest(req, {
    action: 'audit.exported',
    target: { kind: 'system', id: 'admin-audit-log', displayName: 'Audit Log' },
    summary: `exported ${rowCount} audit entries`,
    details: { rowCount, truncated, filters },
  });
  Logger.info('[Admin] Exported admin audit log', { rowCount, truncated });

  // The signed URL is short-lived, so the response must never be cached.
  res.setHeader('Cache-Control', 'no-store');
  const body: AuditExportResult = { url, rowCount, truncated, fileName };
  return res.status(200).json(body);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
