import { describe, expect, it } from 'vitest';
import { Permission } from '@bike4mind/common';
import {
  canReadOrganizationAudit,
  organizationAuditCsv,
  organizationAuditFilter,
  organizationAuditQuerySchema,
} from './organizationAuditRead';

const org = {
  userId: 'owner',
  adminUserIds: ['manager', 'stale'],
  users: [{ userId: 'manager', permissions: [Permission.read] }],
};
describe('organization audit read boundary', () => {
  it('allows the owner and current manager only, without a platform bypass', () => {
    expect(canReadOrganizationAudit({ id: 'owner' }, org)).toBe(true);
    expect(canReadOrganizationAudit({ id: 'manager' }, org)).toBe(true);
    for (const id of ['outsider', 'stale', 'member', 'platform-admin'])
      expect(canReadOrganizationAudit({ id }, org)).toBe(false);
  });
  it('always binds actor, action and inclusive UTC dates to the requested org', () => {
    expect(
      organizationAuditFilter(
        organizationAuditQuerySchema.parse({
          id: 'org-a',
          actor: 'actor',
          action: 'policy.updated',
          from: '2026-01-01',
          to: '2026-01-02',
        })
      )
    ).toEqual({
      organizationId: 'org-a',
      actorUserId: 'actor',
      action: 'policy.updated',
      occurredAt: { $gte: new Date('2026-01-01T00:00:00Z'), $lt: new Date('2026-01-03T00:00:00Z') },
    });
  });
  it('rejects reversed dates, invalid dates and platform event names', () => {
    for (const query of [
      { from: '2026-02-30' },
      { from: '2026-02-02', to: '2026-02-01' },
      { action: 'org.credits.adjusted' },
    ]) {
      expect(organizationAuditQuerySchema.safeParse({ id: 'org', ...query }).success).toBe(false);
    }
  });
  it('escapes CSV and neutralizes spreadsheet formulas', () => {
    const csv = organizationAuditCsv([
      {
        organizationId: 'org',
        actorUserId: '=SUM(1)',
        action: 'policy.updated',
        targetId: 'a,"b',
        occurredAt: new Date('2026-01-01Z'),
      },
    ]);
    expect(csv).toContain('"\'=SUM(1)"');
    expect(csv).toContain('"a,""b"');
    expect(csv).not.toContain('organizationId');
  });
});
