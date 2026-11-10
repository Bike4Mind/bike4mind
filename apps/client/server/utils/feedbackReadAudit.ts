import {
  isSameUserId,
  recordAdminActionFromRequest,
  userAuditTarget,
  type AdminAuditWriter,
} from '@bike4mind/server-utils/utils/adminAudit';

type AuditableRequest = Parameters<typeof recordAdminActionFromRequest>[0] & {
  user?: { id: string; impersonatedBy?: string };
};

type FeedbackReport = { id: string; userId?: string | null };

/**
 * Who is reading. `impersonatedBy` is set when an admin acts as another account: the read is then
 * the admin's, not the account holder's, so it is audited even for that account's own reports
 * (the writer attributes it to the admin, as adminAudit.ts resolveActor does).
 */
export type FeedbackReader = { id: string; impersonatedBy?: string };

/**
 * Records a staff read of other users' feedback text in AdminAuditLog (`feedback.viewed`), awaited
 * before the text is served: the catalogue entry is strict, so a failed write fails the read.
 * Feedback is written to staff, so unlike the support reads in adminSupportAccess.ts no case is
 * required. A read of only the caller's own reports is not a staff read and writes nothing, unless
 * the caller is an admin impersonating that account.
 *
 * Details name the report ids rather than their owners, since AdminAuditLog's data-subject entry
 * (server/dataSubject/registry/infra.ts) resolves `target.id`, never `details`. The caller's own
 * filter values (a userId or a search term, which may be an email) are recorded as given.
 *
 * Only the reports actually returned are audited. A list response's `total` is computed across the
 * whole match set, so a text search that returns an empty page still tells the caller how many
 * reports match the term, and nothing is written for it. That is accepted: `total` discloses a count,
 * not any report's text or owner, and the search term itself is recorded whenever a page returns
 * another user's report.
 */
export async function recordFeedbackReadBy(
  reader: FeedbackReader | undefined,
  write: AdminAuditWriter,
  reports: readonly FeedbackReport[],
  details: Record<string, unknown> = {}
): Promise<void> {
  const isOwnReport = (report: FeedbackReport) =>
    !!reader && !reader.impersonatedBy && !!report.userId && isSameUserId(report.userId, reader.id);
  const othersReports = reports.filter(report => !isOwnReport(report));
  if (othersReports.length === 0) return;

  const owners = new Set(othersReports.map(report => report.userId ?? ''));
  const [singleOwner] = owners;
  const target =
    owners.size === 1 && singleOwner
      ? await userAuditTarget(singleOwner)
      : { kind: 'system' as const, id: 'feedback', displayName: 'feedback reports' };

  await write({
    action: 'feedback.viewed',
    target,
    summary: `viewed ${othersReports.length} feedback report(s) from ${owners.size} user(s)`,
    details: { ...details, feedbackIds: othersReports.map(report => report.id) },
  });
}

/** {@link recordFeedbackReadBy} for an API route: the request's user reads, the request's admin is the actor. */
export async function recordFeedbackRead(
  req: AuditableRequest,
  reports: readonly FeedbackReport[],
  details: Record<string, unknown> = {}
): Promise<void> {
  await recordFeedbackReadBy(req.user, input => recordAdminActionFromRequest(req, input), reports, details);
}
