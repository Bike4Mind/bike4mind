import { describe, it, expect } from 'vitest';
import { IOrganizationDocument } from '@bike4mind/common';
import {
  formatMemberCreditReset,
  formatMemberCreditUsage,
  getMemberCreditBudgetNotice,
  getMemberCreditUsage,
} from './memberCreditBudget';

const now = new Date('2026-10-15T12:00:00Z');
const october = new Date('2026-10-01T00:00:00Z');

const org = (rows: Record<string, unknown>[], maxCreditsPerMember: number | null = 500) =>
  ({
    maxCreditsPerMember,
    userDetails: rows.map(row => ({ id: 'u1', name: 'U', usedCredits: 0, lastCreditUsedAt: null, ...row })),
  }) as unknown as IOrganizationDocument;

describe('getMemberCreditUsage', () => {
  it('distinguishes an untracked member from one who spent nothing', () => {
    expect(getMemberCreditUsage(org([]), 'u1', now)).toEqual({ tracked: false, used: 0, cap: 500, isOverride: false });
    expect(getMemberCreditUsage(org([{ periodStart: october }]), 'u1', now)).toMatchObject({ tracked: true, used: 0 });
  });

  it('reads last month as 0 used and prefers a per-member override', () => {
    const usage = getMemberCreditUsage(
      org([{ usedCredits: 90, periodStart: new Date('2026-09-01T00:00:00Z'), maxCredits: 50 }]),
      'u1',
      now
    );
    expect(usage).toEqual({ tracked: true, used: 0, cap: 50, isOverride: true });
  });
});

describe('formatMemberCreditUsage', () => {
  it.each([
    [{ tracked: false, used: 0, cap: 500, isOverride: false }, 'Not tracked'],
    [{ tracked: true, used: 120.4, cap: null, isOverride: false }, '120'],
    [{ tracked: true, used: 1200, cap: 5000, isOverride: false }, '1,200 / 5,000'],
  ])('%o -> %s', (usage, expected) => {
    expect(formatMemberCreditUsage(usage)).toBe(expected);
  });
});

describe('getMemberCreditBudgetNotice', () => {
  it('stays quiet below 80% of the cap, uncapped, or untracked', () => {
    expect(getMemberCreditBudgetNotice(org([{ usedCredits: 399, periodStart: october }]), 'u1', now)).toBeNull();
    expect(getMemberCreditBudgetNotice(org([{ usedCredits: 9999, periodStart: october }], null), 'u1', now)).toBeNull();
    expect(getMemberCreditBudgetNotice(org([]), 'u1', now)).toBeNull();
  });

  it('warns from 80% and flags exhaustion at the cap', () => {
    expect(getMemberCreditBudgetNotice(org([{ usedCredits: 400, periodStart: october }]), 'u1', now)).toEqual({
      used: 400,
      cap: 500,
      exhausted: false,
      resetsOn: 'November 1',
    });
    expect(getMemberCreditBudgetNotice(org([{ usedCredits: 500, periodStart: october }]), 'u1', now)?.exhausted).toBe(
      true
    );
  });

  it('treats a 0 override as exhausted from the start', () => {
    expect(getMemberCreditBudgetNotice(org([{ periodStart: october, maxCredits: 0 }]), 'u1', now)).toMatchObject({
      exhausted: true,
    });
  });

  it('does not warn on usage left over from last month', () => {
    const lastMonth = new Date('2026-09-01T00:00:00Z');
    expect(getMemberCreditBudgetNotice(org([{ usedCredits: 500, periodStart: lastMonth }]), 'u1', now)).toBeNull();
  });
});

describe('formatMemberCreditReset', () => {
  it('names the first of next month in UTC, rolling the year', () => {
    expect(formatMemberCreditReset(new Date('2026-12-31T23:00:00Z'))).toBe('January 1');
  });
});
