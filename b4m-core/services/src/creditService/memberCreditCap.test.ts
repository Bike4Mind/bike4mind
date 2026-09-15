import { describe, it, expect } from 'vitest';
import { IOrganizationDocument } from '@bike4mind/common';
import {
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
    userDetails: [{ id: 'user1', usedCredits: 40, lastCreditUsedAt: null }],
    ...overrides,
  }) as unknown as IOrganizationDocument;

describe('getMemberUsedCredits', () => {
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
    const overCap = org({ maxCreditsPerMember: 10, userDetails: [{ id: 'user1', usedCredits: 19 } as never] });
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
