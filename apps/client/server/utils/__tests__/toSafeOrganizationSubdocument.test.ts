import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { toSafeOrganizationSubdocument } from '../toSafeOrganizationSubdocument';

/**
 * This is a classifier over a genuinely open-ended input: `.populate('organizationId')` can hand
 * back a hydrated document, a lean plain object, a bare ObjectId (never populated), or null. The
 * truth table below is the point of the test - a bare ObjectId and a populated org are BOTH
 * `typeof 'object'`, and only the ObjectId's toJSON() collapses to a string.
 */

const ORG_ID = '650000000000000000000abc';
const OWNER = 'owner-id';
const MEMBER = 'member-id';

const orgFields = {
  id: ORG_ID,
  userId: OWNER,
  name: 'Acme',
  stripeCustomerId: 'cus_SECRET',
  billingContact: 'billing@acme.example',
};

describe('toSafeOrganizationSubdocument', () => {
  it('redacts a hydrated org document (has toJSON) for a non-owner member', () => {
    const hydrated = { ...orgFields, toJSON: () => ({ ...orgFields }) };

    const result = toSafeOrganizationSubdocument(hydrated, { userId: MEMBER, isAdmin: false }) as Record<
      string,
      unknown
    >;

    expect(result.name).toBe('Acme');
    expect(result.stripeCustomerId).toBeUndefined();
    expect(result.billingContact).toBeUndefined();
  });

  it('redacts a lean org object with no toJSON', () => {
    const result = toSafeOrganizationSubdocument({ ...orgFields }, { userId: MEMBER, isAdmin: false }) as Record<
      string,
      unknown
    >;

    expect(result.name).toBe('Acme');
    expect(result.stripeCustomerId).toBeUndefined();
    expect(result.billingContact).toBeUndefined();
  });

  it('keeps billingContact for the billing owner but never the stripe customer id', () => {
    const result = toSafeOrganizationSubdocument({ ...orgFields }, { userId: OWNER, isAdmin: false }) as Record<
      string,
      unknown
    >;

    expect(result.billingContact).toBe('billing@acme.example');
    expect(result.stripeCustomerId).toBeUndefined();
  });

  // The trap this function exists for: a real ObjectId is `typeof 'object'` and its toJSON()
  // returns a STRING, which the serializer would spread into a character map ({'0': '6', ...}).
  it('passes an unpopulated ObjectId through untouched', () => {
    const objectId = new Types.ObjectId(ORG_ID);

    const result = toSafeOrganizationSubdocument(objectId, { userId: MEMBER, isAdmin: false });

    expect(result).toBe(objectId);
    expect(String(result)).toBe(ORG_ID);
    expect(result).not.toHaveProperty('0');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a bare id string', ORG_ID],
  ])('passes %s through untouched', (_label, value) => {
    expect(toSafeOrganizationSubdocument(value, { userId: MEMBER, isAdmin: false })).toBe(value);
  });
});
