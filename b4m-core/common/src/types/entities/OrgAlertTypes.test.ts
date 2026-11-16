import { describe, it, expect } from 'vitest';
import { orgAlertPeriodKey, resolveOrgAlertOptIn } from './OrgAlertTypes';

describe('resolveOrgAlertOptIn', () => {
  it('defaults an owner in and a manager out when no row exists', () => {
    expect(resolveOrgAlertOptIn('owner', null, 'low_balance')).toBe(true);
    expect(resolveOrgAlertOptIn('manager', undefined, 'low_balance')).toBe(false);
  });

  it('defaults per kind when the row omits that kind', () => {
    const row = { kinds: { seat_limit: true } };
    expect(resolveOrgAlertOptIn('manager', row, 'seat_limit')).toBe(true);
    expect(resolveOrgAlertOptIn('manager', row, 'budget_threshold')).toBe(false);
    expect(resolveOrgAlertOptIn('owner', row, 'budget_threshold')).toBe(true);
  });

  it('honours an explicit false for an owner', () => {
    expect(resolveOrgAlertOptIn('owner', { kinds: { payment_failed: false } }, 'payment_failed')).toBe(false);
  });
});

describe('orgAlertPeriodKey', () => {
  it('returns the UTC month of the instant', () => {
    expect(orgAlertPeriodKey(new Date('2026-03-15T12:00:00Z'))).toBe('2026-03');
    expect(orgAlertPeriodKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
    expect(orgAlertPeriodKey(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01');
  });
});
