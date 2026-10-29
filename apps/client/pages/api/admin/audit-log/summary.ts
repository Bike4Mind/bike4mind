import { adminAuditLogRepository } from '@bike4mind/database';
import { ApiKeyScope, AUDIT_SUMMARY_WINDOWS, type AuditSummary, type AuditSummaryWindow } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const DEFAULT_WINDOW_DAYS: AuditSummaryWindow = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const parseWindow = (raw: unknown): AuditSummaryWindow => {
  if (raw === undefined) return DEFAULT_WINDOW_DAYS;
  const match = AUDIT_SUMMARY_WINDOWS.find(days => String(days) === raw);
  if (!match) throw new BadRequestError(`window must be one of ${AUDIT_SUMMARY_WINDOWS.join(', ')}`);
  return match;
};

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const windowDays = parseWindow(req.query.window);
  const since = new Date(Date.now() - windowDays * DAY_MS);
  const counts = await adminAuditLogRepository.summarize(since);

  const summary: AuditSummary = { windowDays, since: since.toISOString(), ...counts };
  return res.json(summary);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
