import { describe, it, expect } from 'vitest';
import {
  addOrgDomainSchema,
  updateOrgDomainPolicySchema,
  ORG_DOMAIN_MEMBER_PERMISSIONS,
  orgDomainPathIdSchema,
} from './orgDomainClaim';
import { orgAclRowConfersMembership } from '../constants/organization';
import { Permission } from '../types/entities/ShareableDocumentTypes';

describe('addOrgDomainSchema', () => {
  it('trims and lowercases the domain', () => {
    expect(addOrgDomainSchema.parse({ domain: ' ACME.COM ' }).domain).toBe('acme.com');
  });

  it('lets public mail providers through for the service to reject with a reason', () => {
    expect(addOrgDomainSchema.safeParse({ domain: 'gmail.com' }).success).toBe(true);
  });

  it.each(['', '   ', 'localhost', '*.acme.com', '@acme.com', 'user@acme.com', 'acme.com/path', 'acme-.com'])(
    'rejects %j',
    domain => {
      expect(addOrgDomainSchema.safeParse({ domain }).success).toBe(false);
    }
  );

  it('rejects a domain over 253 characters', () => {
    const domain = `${'a'.repeat(60)}.`.repeat(5) + 'com';
    expect(addOrgDomainSchema.safeParse({ domain }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(addOrgDomainSchema.safeParse({ domain: 'acme.com', status: 'verified' }).success).toBe(false);
  });
});

describe('updateOrgDomainPolicySchema', () => {
  it('accepts a policy', () => {
    expect(updateOrgDomainPolicySchema.parse({ policy: 'auto-join' })).toEqual({ policy: 'auto-join' });
  });

  it.each([
    {},
    { policy: 'everyone' },
    { defaultRole: 'viewer' },
    { policy: 'suggest', defaultRole: 'member' },
    { policy: 'off', verificationToken: 'x' },
  ])('rejects %j', body => {
    expect(updateOrgDomainPolicySchema.safeParse(body).success).toBe(false);
  });
});

describe('ORG_DOMAIN_MEMBER_PERMISSIONS', () => {
  it('confers membership', () => {
    expect(orgAclRowConfersMembership({ permissions: [...ORG_DOMAIN_MEMBER_PERMISSIONS] })).toBe(true);
  });

  it('grants no edit, share or delete access', () => {
    expect(ORG_DOMAIN_MEMBER_PERMISSIONS).toEqual([Permission.read]);
  });
});

it('canonicalizes only valid ObjectId path strings', () => {
  expect(orgDomainPathIdSchema.parse('Aa'.repeat(12))).toBe('a'.repeat(24));
  for (const input of ['.*', 'a'.repeat(23), 'g'.repeat(24), ['a'.repeat(24)], null]) {
    expect(orgDomainPathIdSchema.safeParse(input).success).toBe(false);
  }
});
