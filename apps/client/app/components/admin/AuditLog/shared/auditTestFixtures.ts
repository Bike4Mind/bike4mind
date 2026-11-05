import type { AuditEntry, AuditReview, AuditReviewQueueEntry } from '@bike4mind/common';

export const makeAuditEntry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 'entry-1',
  source: 'admin',
  occurredAt: new Date('2026-10-01T12:00:00Z'),
  action: 'credits.granted',
  category: 'credits',
  severity: 'info',
  actor: { kind: 'user', scope: 'platform', userId: 'admin-1', name: 'Alice Admin', wasAdmin: true },
  target: { kind: 'user', id: 'user-1', displayName: 'Bob Builder' },
  summary: 'Granted 100 credits',
  context: { source: 'admin_ui' },
  ...overrides,
});

export const makeAuditReview = (overrides: Partial<AuditReview> = {}): AuditReview => ({
  auditEntryId: 'entry-1',
  reviewer: { userId: 'reviewer-1', name: 'Rita Reviewer' },
  reviewedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  ...overrides,
});

export const makeReviewQueueEntry = (
  overrides: Partial<AuditEntry> & { review?: AuditReview | null } = {}
): AuditReviewQueueEntry => {
  const { review = null, ...entryOverrides } = overrides;
  return { ...makeAuditEntry({ severity: 'critical', ...entryOverrides }), review };
};
