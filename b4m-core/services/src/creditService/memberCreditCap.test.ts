import { describe, it, expect } from 'vitest';
import { IOrganizationDocument } from '@bike4mind/common';
import {
  getMemberCreditCap,
  getMemberCreditPeriodEnd,
  getMemberCreditPeriodStart,
  getMemberUsedCredits,
  isMemberAtOrOverCap,
  isMemberCreditCapExceeded,
  isMemberCreditCapError,
  MemberCreditCapError,
} from './memberCreditCap';

const org = (overrides: Partial<IOrganizationDocument>): IOrganizationDocument =>
  ({
    id: 'org1',
    maxCreditsPerMember: null,
    userDetails: [{ id: 'user1', usedCredits: 40, lastCreditUsedAt: null, periodStart: getMemberCreditPeriodStart() }],
    ...overrides,
  }) as unknown as IOrganizationDocument;

const row = (extra: Record<string, unknown>) => ({ id: 'user1', usedCredits: 40, lastCreditUsedAt: null, ...extra });

describe('member credit period', () => {
  it('starts at the first instant of the UTC calendar month', () => {
    expect(getMemberCreditPeriodStart(new Date('2026-10-15T12:00:00Z'))).toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  it('uses the UTC month, not the server-local one, at a month boundary', () => {
    expect(getMemberCreditPeriodStart(new Date('2026-10-31T23:59:59Z'))).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(getMemberCreditPeriodStart(new Date('2026-11-01T00:00:00Z'))).toEqual(new Date('2026-11-01T00:00:00Z'));
  });

  it('ends at the start of the next month, rolling over the year', () => {
    expect(getMemberCreditPeriodEnd(new Date('2026-12-20T00:00:00Z'))).toEqual(new Date('2027-01-01T00:00:00Z'));
  });
});

describe('getMemberUsedCredits', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  it('counts usage stamped with the current period', () => {
    const organization = org({ userDetails: [row({ periodStart: new Date('2026-10-01T00:00:00Z') })] });
    expect(getMemberUsedCredits(organization, 'user1', now)).toBe(40);
  });

  it('reads usage from an earlier month as 0 (the budget has reset)', () => {
    const organization = org({ userDetails: [row({ periodStart: new Date('2026-09-01T00:00:00Z') })] });
    expect(getMemberUsedCredits(organization, 'user1', now)).toBe(0);
  });

  it('reads a legacy row with no periodStart as 0 (a lifetime counter, not this month)', () => {
    expect(getMemberUsedCredits(org({ userDetails: [row({})] }), 'user1', now)).toBe(0);
  });

  it('returns the tracked usedCredits for a known member', () => {
    expect(getMemberUsedCredits(org({}), 'user1')).toBe(40);
  });

  it('returns 0 for a member with no userDetails row', () => {
    expect(getMemberUsedCredits(org({}), 'stranger')).toBe(0);
  });

  it('returns 0 when userDetails is absent', () => {
    expect(getMemberUsedCredits(org({ userDetails: undefined }), 'user1')).toBe(0);
  });
});

describe('getMemberCreditCap', () => {
  it('is the org default when the member has no override', () => {
    expect(getMemberCreditCap(org({ maxCreditsPerMember: 100 }), 'user1')).toBe(100);
  });

  it('prefers the per-member override over the org default, in either direction', () => {
    const userDetails = [row({ maxCredits: 500 })];
    expect(getMemberCreditCap(org({ maxCreditsPerMember: 100, userDetails }), 'user1')).toBe(500);
    expect(getMemberCreditCap(org({ maxCreditsPerMember: 100, userDetails: [row({ maxCredits: 10 })] }), 'user1')).toBe(
      10
    );
  });

  it('caps a member with an override even when the org sets no default', () => {
    expect(getMemberCreditCap(org({ userDetails: [row({ maxCredits: 25 })] }), 'user1')).toBe(25);
  });

  it('is null (uncapped) when neither is set, and inherits when the override is null', () => {
    expect(getMemberCreditCap(org({}), 'user1')).toBeNull();
    expect(
      getMemberCreditCap(org({ maxCreditsPerMember: 100, userDetails: [row({ maxCredits: null })] }), 'user1')
    ).toBe(100);
  });
});

describe('isMemberCreditCapExceeded', () => {
  it('is false when no cap is configured (null)', () => {
    expect(isMemberCreditCapExceeded(org({ maxCreditsPerMember: null }), 'user1', 1_000_000)).toBe(false);
  });

  it('is false when no cap is configured (undefined)', () => {
    expect(isMemberCreditCapExceeded(org({ maxCreditsPerMember: undefined }), 'user1', 1_000_000)).toBe(false);
  });

  it('is false when the charge stays under the cap', () => {
    expect(isMemberCreditCapExceeded(org({ maxCreditsPerMember: 50 }), 'user1', 5)).toBe(false);
  });

  it('is false when the charge lands exactly on the cap', () => {
    // 40 used + 10 = 50 == cap; the cap is a ceiling, not a strict upper bound.
    expect(isMemberCreditCapExceeded(org({ maxCreditsPerMember: 50 }), 'user1', 10)).toBe(false);
  });

  it('is true when the charge would exceed the cap', () => {
    expect(isMemberCreditCapExceeded(org({ maxCreditsPerMember: 50 }), 'user1', 11)).toBe(true);
  });

  it('treats an untracked member as 0 used, so a single charge over the cap trips immediately', () => {
    expect(isMemberCreditCapExceeded(org({ maxCreditsPerMember: 10 }), 'stranger', 57)).toBe(true);
  });

  it('is true once a member is already at/over the cap, even for a tiny charge (the #1536 compounding case)', () => {
    const overCap = org({
      maxCreditsPerMember: 10,
      userDetails: [{ id: 'user1', usedCredits: 19, periodStart: getMemberCreditPeriodStart() } as never],
    });
    expect(isMemberCreditCapExceeded(overCap, 'user1', 1)).toBe(true);
  });
});

describe('isMemberAtOrOverCap', () => {
  it('is false when no cap is configured (null)', () => {
    expect(isMemberAtOrOverCap(org({ maxCreditsPerMember: null }), 'user1')).toBe(false);
  });

  it('is false when no cap is configured (undefined)', () => {
    expect(isMemberAtOrOverCap(org({ maxCreditsPerMember: undefined }), 'user1')).toBe(false);
  });

  it('is false when the member is under the cap', () => {
    expect(isMemberAtOrOverCap(org({ maxCreditsPerMember: 50 }), 'user1')).toBe(false);
  });

  it('is true exactly at the cap (>=, no estimate to add unlike isMemberCreditCapExceeded)', () => {
    // 40 used, cap 40: the estimate-based helper treats this boundary as allowed; this one blocks.
    expect(isMemberAtOrOverCap(org({ maxCreditsPerMember: 40 }), 'user1')).toBe(true);
  });

  it('is true when the member is over the cap', () => {
    expect(isMemberAtOrOverCap(org({ maxCreditsPerMember: 10 }), 'user1')).toBe(true);
  });

  it('treats an untracked member as 0 used, so a positive cap does not block them', () => {
    expect(isMemberAtOrOverCap(org({ maxCreditsPerMember: 10 }), 'stranger')).toBe(false);
  });
});

describe('cap predicates with a per-member override and a rolled-over period', () => {
  it('enforces the override instead of the org default', () => {
    const organization = org({
      maxCreditsPerMember: 1000,
      userDetails: [row({ maxCredits: 40, periodStart: getMemberCreditPeriodStart() })],
    });
    expect(isMemberAtOrOverCap(organization, 'user1')).toBe(true);
    expect(isMemberCreditCapExceeded(organization, 'user1', 1)).toBe(true);
  });

  it('unblocks a member whose spend belongs to last month', () => {
    const lastMonth = new Date(getMemberCreditPeriodStart().getTime() - 1);
    const organization = org({
      maxCreditsPerMember: 40,
      userDetails: [row({ periodStart: getMemberCreditPeriodStart(lastMonth) })],
    });
    expect(isMemberAtOrOverCap(organization, 'user1')).toBe(false);
    expect(isMemberCreditCapExceeded(organization, 'user1', 40)).toBe(false);
  });
});

describe('isMemberCreditCapError', () => {
  it('is true for a bare MemberCreditCapError', () => {
    expect(isMemberCreditCapError(new MemberCreditCapError())).toBe(true);
  });

  it('is true when the error is wrapped via .cause, surviving a rewrap that changes the message', () => {
    const wrapped = new Error('Subagent execution failed', { cause: new MemberCreditCapError() });
    expect(isMemberCreditCapError(wrapped)).toBe(true);
  });

  it('is true through multiple levels of .cause wrapping', () => {
    const innerWrapped = new Error('retry exhausted', { cause: new MemberCreditCapError() });
    const outerWrapped = new Error('request failed', { cause: innerWrapped });
    expect(isMemberCreditCapError(outerWrapped)).toBe(true);
  });

  it('is false for an unrelated error, even one with a matching message string', () => {
    expect(isMemberCreditCapError(new Error('Organization member credit limit reached'))).toBe(false);
  });

  it('is false for a non-Error value', () => {
    expect(isMemberCreditCapError('Organization member credit limit reached')).toBe(false);
    expect(isMemberCreditCapError(undefined)).toBe(false);
  });
});
