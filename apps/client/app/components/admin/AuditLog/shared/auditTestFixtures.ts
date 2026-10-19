import type { AuditEntry } from '@bike4mind/common';

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
