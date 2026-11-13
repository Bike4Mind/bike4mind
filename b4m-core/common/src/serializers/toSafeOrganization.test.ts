import { describe, it, expect } from 'vitest';
import type { IOrganization } from '../types/entities/OrganizationTypes';
import {
  ORGANIZATION_ADMINISTRATOR_ONLY_FIELDS,
  ORGANIZATION_MEMBER_VISIBLE_FIELDS,
  ORGANIZATION_OWNER_ONLY_FIELDS,
  ORGANIZATION_SECRET_FIELDS,
  toSafeOrganization,
  toSafeOrganizations,
} from './toSafeOrganization';

const creditPeriod = new Date('2026-01-01');
const fullOrg = {
  id: 'org1',
  userId: 'owner1',
  name: 'Acme',
  description: 'desc',
  seats: 5,
  currentCredits: 1000,
  systemPrompt: 'internal enterprise context',
  preferredModel: 'model-x',
  sharingPolicy: { allowPublicLinks: false },
  allowedGroupTypes: ['team'],
  maxCreditsPerMember: 100,
  mfaPolicy: { required: true, graceEndsAt: null },
  unclassifiedFutureField: 'not in the interface',
  billingContact: 'billing@acme.com',
  budgetAlerts: { enabled: true, monthlyBudgetCredits: 5000, percentThresholds: [80], lowBalanceCredits: 100 },
  stripeCustomerId: 'cus_SECRET',
  signupGrantUnlockCount: 3,
  adminUserIds: ['manager1', 'former-manager'],
  users: [
    { userId: 'manager1', permissions: ['read'] },
    { userId: 'member2', permissions: ['read'] },
    { userId: 'editor3', permissions: ['read', 'update'] },
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

  it('keeps budgetAlerts for the owner, a current manager and a site admin', () => {
    for (const viewer of [
      { userId: 'owner1', isAdmin: false },
      { userId: 'manager1', isAdmin: false },
      { userId: 'admin1', isAdmin: true },
    ]) {
      expect(toSafeOrganization(fullOrg, viewer)!.budgetAlerts).toEqual(fullOrg.budgetAlerts);
    }
  });

  it('drops budgetAlerts for a plain member and a stale manager without a users row', () => {
    for (const viewer of [
      { userId: 'member2', isAdmin: false },
      { userId: 'former-manager', isAdmin: false },
    ]) {
      expect('budgetAlerts' in toSafeOrganization(fullOrg, viewer)!).toBe(false);
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

  it('shows billingContact to a billing manager and hides it from a manager', () => {
    const org = {
      ...fullOrg,
      billingManagerUserIds: ['biller1'],
      users: [...(fullOrg as unknown as { users: unknown[] }).users, { userId: 'biller1', permissions: ['read'] }],
    } as unknown as IOrganization;
    expect(toSafeOrganization(org, { userId: 'biller1', isAdmin: false })!.billingContact).toBe('billing@acme.com');
    expect('billingContact' in toSafeOrganization(org, { userId: 'manager1', isAdmin: false })!).toBe(false);
  });

  it('drops billingContact for a non-owner, non-admin member', () => {
    const safe = toSafeOrganization(fullOrg, { userId: 'member2', isAdmin: false })!;
    expect('billingContact' in safe).toBe(false);
    expect('stripeCustomerId' in safe).toBe(false);
  });

  it('gives a plain member only the member-visible fields', () => {
    const safe = toSafeOrganization(fullOrg, { userId: 'member2', isAdmin: false })!;
    for (const field of Object.keys(safe)) {
      expect(ORGANIZATION_MEMBER_VISIBLE_FIELDS).toContain(field);
    }
    expect(safe).toMatchObject({
      id: 'org1',
      name: 'Acme',
      userId: 'owner1',
      seats: 5,
      currentCredits: 1000,
      maxCreditsPerMember: 100,
      adminUserIds: fullOrg.adminUserIds,
      mfaPolicy: { required: true, graceEndsAt: null },
    });
  });

  it.each(['systemPrompt', 'preferredModel', 'sharingPolicy', 'allowedGroupTypes', 'unclassifiedFutureField'])(
    'withholds %s from a plain member and a stale manager',
    field => {
      expect(field in toSafeOrganization(fullOrg, { userId: 'member2', isAdmin: false })!).toBe(false);
      expect(field in toSafeOrganization(fullOrg, { userId: 'former-manager', isAdmin: false })!).toBe(false);
    }
  );

  it.each([
    ['owner', 'owner1', false],
    ['current manager', 'manager1', false],
    ['platform admin', 'admin1', true],
  ])('keeps organization settings for the %s', (_role, userId, isAdmin) => {
    const safe = toSafeOrganization(fullOrg, { userId, isAdmin })!;
    expect(safe.systemPrompt).toBe('internal enterprise context');
    expect(safe.preferredModel).toBe('model-x');
    expect(safe.sharingPolicy).toEqual({ allowPublicLinks: false });
  });

  it('withholds billingContact from a current manager who is not the owner', () => {
    expect('billingContact' in toSafeOrganization(fullOrg, { userId: 'manager1', isAdmin: false })!).toBe(false);
  });

  it('gives a member who may edit the profile the settings, but not budgets or colleagues credits', () => {
    const safe = toSafeOrganization(fullOrg, { userId: 'editor3', isAdmin: false })!;
    expect(safe.systemPrompt).toBe('internal enterprise context');
    expect(safe.sharingPolicy).toEqual({ allowPublicLinks: false });
    expect('budgetAlerts' in safe).toBe(false);
    expect('billingContact' in safe).toBe(false);
    expect('stripeCustomerId' in safe).toBe(false);
    expect(JSON.stringify(safe.userDetails)).not.toMatch(/usedCredits|maxCredits|lastCreditUsedAt|periodStart/);
  });

  it('assigns every field to exactly one visibility list', () => {
    const all = [
      ...ORGANIZATION_MEMBER_VISIBLE_FIELDS,
      ...ORGANIZATION_ADMINISTRATOR_ONLY_FIELDS,
      ...ORGANIZATION_OWNER_ONLY_FIELDS,
      ...ORGANIZATION_SECRET_FIELDS,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps _id for a plain member when the input is a plain object', () => {
    const safe = toSafeOrganization({ ...fullOrg, _id: 'org1' } as never, { userId: 'member2' })!;
    expect(safe._id).toBe('org1');
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
