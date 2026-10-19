import { describe, expect, it } from 'vitest';
import { AuditEntrySchema } from './AdminAuditLogTypes';
import { ADMIN_AUDIT_CATALOGUE } from './adminAuditCatalogue';

const CATEGORIES = ['credits', 'access', 'identity', 'account', 'org', 'settings', 'support'];

const validEntry = {
  id: '507f1f77bcf86cd799439011',
  source: 'admin',
  occurredAt: new Date('2026-10-19T12:00:00.000Z'),
  action: 'org.credits.granted',
  category: 'credits',
  severity: 'notice',
  actor: { kind: 'user', scope: 'platform', userId: 'u1', email: 'a@example.com', name: 'Admin', wasAdmin: true },
  target: { kind: 'organization', id: 'o1', displayName: 'Acme' },
  organizationId: 'o1',
  summary: 'Granted 100 credits',
  changes: [{ field: 'credits', before: 0, after: 100 }],
  details: { note: 'x' },
  context: { ip: '127.0.0.1', source: 'admin_ui', route: '/api/x' },
  related: { creditTransactionId: 't1' },
};

describe('AuditEntrySchema', () => {
  it('accepts a full valid entry', () => {
    expect(AuditEntrySchema.parse(validEntry)).toMatchObject({ action: 'org.credits.granted' });
  });

  it('rejects an unknown severity', () => {
    expect(AuditEntrySchema.safeParse({ ...validEntry, severity: 'high' }).success).toBe(false);
  });
});

describe('ADMIN_AUDIT_CATALOGUE', () => {
  const entries = Object.entries(ADMIN_AUDIT_CATALOGUE);

  it.each(entries.map(([action]) => action))('%s is a dotted lowercase action key', action => {
    expect(action).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  });

  it.each(entries.map(([action, entry]) => [action, entry.category] as const))(
    '%s has a known category',
    (_action, category) => {
      expect(CATEGORIES).toContain(category);
    }
  );
});
