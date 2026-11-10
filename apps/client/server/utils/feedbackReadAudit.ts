import { isSameUserId, recordAdminActionFromRequest, userAuditTarget } from '@bike4mind/server-utils/utils/adminAudit';

type AuditableRequest = Parameters<typeof recordAdminActionFromRequest>[0] & { user?: { id: string } };

type FeedbackReport = { id: string; userId?: string | null };

/**
 * Records a staff read of other users' feedback text in AdminAuditLog (`feedback.viewed`), awaited
 * before the text is served: the catalogue entry is strict, so a failed write fails the read.
 * Feedback is written to staff, so unlike the support reads in adminSupportAccess.ts no case is
 * required. A read of only the caller's own reports is not a staff read and writes nothing.
 *
 * Details name the report ids rather than their owners, since AdminAuditLog's data-subject entry
 * (server/dataSubject/registry/infra.ts) resolves `target.id`, never `details`. The caller's own
 * filter values (a userId or a search term, which may be an email) are recorded as given.
 */
export async function recordFeedbackRead(
  req: AuditableRequest,
  reports: readonly FeedbackReport[],
  details: Record<string, unknown> = {}
): Promise<void> {
  const readerId = req.user?.id;
  const othersReports = reports.filter(report => !readerId || !report.userId || !isSameUserId(report.userId, readerId));
  if (othersReports.length === 0) return;

  const owners = new Set(othersReports.map(report => report.userId ?? ''));
  const [singleOwner] = owners;
  const target =
    owners.size === 1 && singleOwner
      ? await userAuditTarget(singleOwner)
      : { kind: 'system' as const, id: 'feedback', displayName: 'feedback reports' };

  await recordAdminActionFromRequest(req, {
    action: 'feedback.viewed',
    target,
    summary: `viewed ${othersReports.length} feedback report(s) from ${owners.size} user(s)`,
    details: { ...details, feedbackIds: othersReports.map(report => report.id) },
  });
}
