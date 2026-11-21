import { describe, expect, it } from 'vitest';
import type { AccessReviewRow, WireAccessReviewDecision } from '@client/app/hooks/data/adminAccessReview';
import { buildReviewRows, countByStatus, filterByStatus, isSuggestedRevoke } from './accessReviewRows';

const id = (char: string) => char.repeat(24);

const admin = (overrides: Partial<AccessReviewRow>): AccessReviewRow => ({
  userId: id('a'),
  email: null,
  username: null,
  fullAdmin: true,
  permissions: [],
  directPermissions: [],
  adminRoleIds: [],
  roles: [],
  permissionSources: [],
  lastAdminActionAt: null,
  lastSignInAt: null,
  mfaEnabled: true,
  grantedBy: null,
  grantedAt: null,
  dormant: false,
  noMfa: false,
  decision: null,
  ...overrides,
});

const decision = (userId: string, value: 'confirmed' | 'revoked'): WireAccessReviewDecision => ({
  userId,
  email: null,
  fullAdmin: true,
  permissions: [],
  decision: value,
  reviewer: { userId: id('f'), name: 'Reviewer' },
  decidedAt: '2026-11-02T00:00:00.000Z',
});

const record = (decisions: WireAccessReviewDecision[]) => ({
  id: 'r1',
  quarter: '2026-Q4',
  dormantDays: 90,
  startedAt: '2026-11-01T00:00:00.000Z',
  startedBy: { userId: id('f'), name: 'Reviewer' },
  completedAt: null,
  completedBy: null,
  decisions,
});

describe('buildReviewRows', () => {
  const rows = buildReviewRows({
    admins: [
      admin({ userId: id('a'), decision: decision(id('a'), 'confirmed') }),
      admin({ userId: id('b') }),
      // Revoked earlier this quarter, then re-granted: needs a new decision.
      admin({ userId: id('c'), decision: decision(id('c'), 'revoked') }),
    ],
    record: record([decision(id('d'), 'revoked'), decision(id('a'), 'confirmed')]),
  });

  it('sorts pending first, then confirmed, then revoked, keeping server order within a status', () => {
    expect(rows.map(row => [row.userId, row.status])).toEqual([
      [id('b'), 'pending'],
      [id('c'), 'pending'],
      [id('a'), 'confirmed'],
      [id('d'), 'revoked'],
    ]);
  });

  it('counts each status, and all rows', () => {
    expect(countByStatus(rows)).toEqual({ all: 4, pending: 2, confirmed: 1, revoked: 1 });
  });

  it('filters to one status, or every row for all', () => {
    expect(filterByStatus(rows, 'pending').map(row => row.userId)).toEqual([id('b'), id('c')]);
    expect(filterByStatus(rows, 'revoked').map(row => row.userId)).toEqual([id('d')]);
    expect(filterByStatus(rows, 'all')).toHaveLength(4);
  });

  it('builds no rows from an empty report', () => {
    expect(buildReviewRows({ admins: [], record: null })).toEqual([]);
  });
});

describe('isSuggestedRevoke', () => {
  const risky = { fullAdmin: true, dormant: true, noMfa: true, mfaEnabled: false };
  const pendingRow = (overrides: Partial<AccessReviewRow>) =>
    buildReviewRows({ admins: [admin(overrides)], record: null })[0];

  it('suggests revoking a pending full admin who is dormant and has no MFA', () => {
    expect(isSuggestedRevoke(pendingRow(risky))).toBe(true);
  });

  it.each([
    ['not a full admin', { fullAdmin: false }],
    ['active', { dormant: false }],
    ['protected by MFA', { noMfa: false, mfaEnabled: true }],
  ])('does not suggest it when the admin is %s', (_name, overrides) => {
    expect(isSuggestedRevoke(pendingRow({ ...risky, ...overrides }))).toBe(false);
  });

  it('does not suggest it once the admin is confirmed', () => {
    const [confirmed] = buildReviewRows({
      admins: [admin({ ...risky, decision: decision(id('a'), 'confirmed') })],
      record: null,
    });
    expect(isSuggestedRevoke(confirmed)).toBe(false);
  });
});
