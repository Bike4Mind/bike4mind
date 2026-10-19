import { adminAuditLogRepository } from '@bike4mind/database';
import {
  ApiKeyScope,
  AUDIT_EXPORT_MAX_ROWS,
  type AuditEntry,
  type AuditLogCursor,
  type AuditLogFilters,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { toCsv } from '@client/app/utils/csv';
import { baseApi } from '@server/middlewares/baseApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { ensurePlatformAdmin, parseAuditExportQuery } from '@server/utils/adminAuditQuery';

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

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensurePlatformAdmin(req.user);
  const filters = parseAuditExportQuery(req.query);

  const { entries, truncated } = await collectEntries(filters);
  const csv = toCsv([CSV_HEADER, ...entries.map(toCsvRow)]);

  const rowCount = entries.length;
  await recordAdminActionFromRequest(req, {
    action: 'audit.exported',
    target: { kind: 'system', id: 'admin-audit-log', displayName: 'Audit Log' },
    summary: `exported ${rowCount} audit entries`,
    details: { rowCount, truncated, filters },
  });
  Logger.info('[Admin] Exported admin audit log', { rowCount, truncated });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('X-Audit-Export-Truncated', String(truncated));
  return res.status(200).send(csv);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
