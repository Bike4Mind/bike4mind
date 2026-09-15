import { describe, it, expect } from 'vitest';
import type { IOrganization } from '../types/entities/OrganizationTypes';
import { toSafeOrganization, toSafeOrganizations } from './toSafeOrganization';

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
  userDetails: [{ id: 'owner1', email: 'owner@acme.com', name: 'Owner', usedCredits: 10, lastCreditUsedAt: null }],
} as unknown as IOrganization;

describe('toSafeOrganization', () => {
  it('drops stripeCustomerId for every caller (owner included)', () => {
    for (const viewer of [
      { userId: 'owner1', isAdmin: false },
      { userId: 'admin1', isAdmin: true },
      { userId: 'stranger', isAdmin: false },
    ]) {
      expect('stripeCustomerId' in toSafeOrganization(fullOrg, viewer)!).toBe(false);
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
