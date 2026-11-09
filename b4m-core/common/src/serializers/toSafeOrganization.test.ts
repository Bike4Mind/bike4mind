import { describe, it, expect } from 'vitest';
import type { IOrganization } from '../types/entities/OrganizationTypes';
import { toSafeOrganization, toSafeOrganizations } from './toSafeOrganization';

const creditPeriod = new Date('2026-01-01');
const fullOrg = {
  id: 'org1',
  userId: 'owner1',
  name: 'Acme',
  description: 'desc',
  seats: 5,
  currentCredits: 1000,
  systemPrompt: 'internal enterprise context',
  billingContact: 'billing@acme.com',
  stripeCustomerId: 'cus_SECRET',
  signupGrantUnlockCount: 3,
  adminUserIds: ['manager1', 'former-manager'],
  users: [
    { userId: 'manager1', permissions: ['read'] },
    { userId: 'member2', permissions: ['read'] },
  ],
  userDetails: [
    {
      id: 'owner1',
      email: 'owner@acme.com',
      name: 'Owner',
      usedCredits: 10,
      maxCredits: 50,
      lastCreditUsedAt: null,
      periodStart: creditPeriod,
    },
    {
      id: 'member2',
      email: 'member@acme.com',
      name: 'Member',
      usedCredits: 20,
      maxCredits: 60,
      lastCreditUsedAt: creditPeriod,
      periodStart: creditPeriod,
    },
  ],
} as unknown as IOrganization;

describe('toSafeOrganization', () => {
  it('drops stripeCustomerId for every caller (owner included)', () => {
    for (const viewer of [
      { userId: 'owner1', isAdmin: false },
      { userId: 'admin1', isAdmin: true },
      { userId: 'stranger', isAdmin: false },
    ]) {
      expect('stripeCustomerId' in toSafeOrganization(fullOrg, viewer)!).toBe(false);
      expect('signupGrantUnlockCount' in toSafeOrganization(fullOrg, viewer)!).toBe(false);
    }
  });

  it('keeps billingContact for the owner', () => {
    const safe = toSafeOrganization(fullOrg, { userId: 'owner1', isAdmin: false })!;
    expect(safe.billingContact).toBe('billing@acme.com');
  });

  it('keeps billingContact for a site admin (non-owner)', () => {
    const safe = toSafeOrganization(fullOrg, { userId: 'admin1', isAdmin: true })!;
    expect(safe.billingContact).toBe('billing@acme.com');
  });

  it('drops billingContact for a non-owner, non-admin member', () => {
    const safe = toSafeOrganization(fullOrg, { userId: 'member2', isAdmin: false })!;
    expect('billingContact' in safe).toBe(false);
    expect('stripeCustomerId' in safe).toBe(false);
  });

  it('preserves in-org fields (name/systemPrompt/userDetails/seats/credits) for members', () => {
    const safe = toSafeOrganization(fullOrg, { userId: 'member2', isAdmin: false })!;
    expect(safe.name).toBe('Acme');
    expect(safe.systemPrompt).toBe('internal enterprise context');
    expect(safe.seats).toBe(5);
    expect(safe.currentCredits).toBe(1000);
    expect(Array.isArray(safe.userDetails)).toBe(true);
  });

  it("removes credit details from co-member rows but keeps the viewer's own row for a plain member", () => {
    const safe = toSafeOrganization(fullOrg, { userId: 'member2', isAdmin: false })!;
    expect(safe.userDetails).toEqual([
      { id: 'owner1', email: 'owner@acme.com', name: 'Owner' },
      fullOrg.userDetails[1],
    ]);
    expect(JSON.stringify(safe.userDetails![0])).not.toMatch(/usedCredits|maxCredits|lastCreditUsedAt|periodStart/);
    expect(fullOrg.userDetails[0].usedCredits).toBe(10);
  });

  it.each([
    ['owner', 'owner1', false],
    ['current manager', 'manager1', false],
    ['platform admin', 'admin1', true],
  ])('keeps member credit details for the %s', (_role, userId, isAdmin) => {
    expect(toSafeOrganization(fullOrg, { userId, isAdmin })!.userDetails).toEqual(fullOrg.userDetails);
  });

  it('does not privilege a stale manager without a users row', () => {
    const safe = toSafeOrganization(fullOrg, { userId: 'former-manager' })!;
    expect(JSON.stringify(safe.userDetails)).not.toMatch(/usedCredits|maxCredits|lastCreditUsedAt|periodStart/);
  });

  it('never leaks stripeCustomerId value anywhere in the output', () => {
    const safe = toSafeOrganization(fullOrg, { userId: 'stranger', isAdmin: false });
    expect(JSON.stringify(safe)).not.toContain('cus_SECRET');
  });

  it('normalizes a Mongoose-style doc via toJSON before stripping', () => {
    const doc = { toJSON: () => fullOrg };
    const safe = toSafeOrganization(doc as never, { userId: 'stranger', isAdmin: false })!;
    expect(safe.name).toBe('Acme');
    expect('stripeCustomerId' in safe).toBe(false);
    expect('billingContact' in safe).toBe(false);
  });

  it('returns null for null/undefined input', () => {
    expect(toSafeOrganization(null, { userId: 'x' })).toBeNull();
    expect(toSafeOrganization(undefined, { userId: 'x' })).toBeNull();
  });

  it('toSafeOrganizations maps and drops null entries', () => {
    const out = toSafeOrganizations([fullOrg, null, undefined], { userId: 'stranger', isAdmin: false });
    expect(out).toHaveLength(1);
    expect('billingContact' in out[0]).toBe(false);
  });
});
