import { describe, it, expect } from 'vitest';
import { addOrgDomainSchema, updateOrgDomainPolicySchema, ORG_DOMAIN_ROLE_PERMISSIONS } from './orgDomainClaim';
import { orgAclRowConfersMembership } from '../constants/organization';

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
  it('accepts a policy and role', () => {
    expect(updateOrgDomainPolicySchema.parse({ policy: 'auto-join', defaultRole: 'viewer' })).toEqual({
      policy: 'auto-join',
      defaultRole: 'viewer',
    });
  });

  it.each([{}, { policy: 'everyone' }, { defaultRole: 'admin' }, { policy: 'off', verificationToken: 'x' }])(
    'rejects %j',
    body => {
      expect(updateOrgDomainPolicySchema.safeParse(body).success).toBe(false);
    }
  );
});

describe('ORG_DOMAIN_ROLE_PERMISSIONS', () => {
  it.each(Object.entries(ORG_DOMAIN_ROLE_PERMISSIONS))('%s confers membership', (_role, permissions) => {
    expect(orgAclRowConfersMembership({ permissions })).toBe(true);
  });
});
