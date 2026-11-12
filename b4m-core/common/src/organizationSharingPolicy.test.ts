import { describe, expect, it } from 'vitest';
import {
  organizationAllowsRecipient,
  organizationSharingPolicy,
  OrganizationSharingPolicySchema,
} from './organizationSharingPolicy';
import type { IOrganizationDocument } from './types/entities/OrganizationTypes';

const org = {
  userId: 'owner',
  users: [{ userId: 'member', permissions: ['read'] }],
  sharingPolicy: { allowPublicLinks: false, allowExternalSharing: false, allowedDomains: ['partner.example'] },
} as IOrganizationDocument;

describe('organization sharing policy', () => {
  it('preserves permissive defaults for organizations with no policy', () => {
    expect(organizationSharingPolicy({})).toEqual({
      allowPublicLinks: true,
      allowExternalSharing: true,
      allowedDomains: [],
    });
  });
  it.each(['owner', 'member'])('allows member %s without relying on email domain', id => {
    expect(organizationAllowsRecipient(org, { id })).toBe(true);
  });
  it('allows exact normalized external domains, not suffixes or subdomains', () => {
    expect(organizationAllowsRecipient(org, { id: 'external', email: 'PERSON@PARTNER.EXAMPLE' })).toBe(true);
    for (const email of ['x@sub.partner.example', 'x@evilpartner.example', 'x@partner.example.evil', undefined]) {
      expect(organizationAllowsRecipient(org, { id: 'external', email })).toBe(false);
    }
  });
  it('validates and normalizes domain input', () => {
    expect(
      OrganizationSharingPolicySchema.parse({ ...org.sharingPolicy, allowedDomains: [' Partner.Example '] })
        .allowedDomains
    ).toEqual(['partner.example']);
    for (const domain of ['@partner.example', 'https://partner.example', '*.partner.example', '']) {
      expect(
        OrganizationSharingPolicySchema.safeParse({ ...org.sharingPolicy, allowedDomains: [domain] }).success
      ).toBe(false);
    }
  });
});
