import { CreditHolderType } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { billedOrganizationIdForFreeze, spendFreezeSubjectForRequest } from './spendFreezeSubject';

const user = { id: 'u1' };

describe('spendFreezeSubjectForRequest', () => {
  it('names the user and the billing org for a JWT caller', () => {
    expect(spendFreezeSubjectForRequest({ user }, 'org1')).toEqual({
      userId: 'u1',
      organizationId: 'org1',
      apiKeyId: null,
    });
  });

  it('names the user alone when no org is billed', () => {
    expect(spendFreezeSubjectForRequest({ user }, null)).toEqual({
      userId: 'u1',
      organizationId: null,
      apiKeyId: null,
    });
  });

  it('names the key and its owner for a user-billed key', () => {
    const apiKeyInfo = { keyId: 'k1', billingOwnerType: CreditHolderType.User };
    expect(spendFreezeSubjectForRequest({ user, apiKeyInfo }, null)).toEqual({
      userId: 'u1',
      organizationId: null,
      apiKeyId: 'k1',
    });
  });

  it('keeps the minting user on an org-billed key, so a frozen user cannot spend through it', () => {
    const apiKeyInfo = { keyId: 'k1', billingOwnerType: CreditHolderType.Organization };
    expect(spendFreezeSubjectForRequest({ user, apiKeyInfo }, 'org1')).toEqual({
      userId: 'u1',
      organizationId: 'org1',
      apiKeyId: 'k1',
    });
  });
});

describe('billedOrganizationIdForFreeze', () => {
  it('is the key org for an org-billed key', () => {
    expect(
      billedOrganizationIdForFreeze({ billingOwnerType: CreditHolderType.Organization, organizationId: 'org-9' })
    ).toBe('org-9');
  });

  it.each([
    ['no key', undefined],
    ['a user-billed key', { billingOwnerType: CreditHolderType.User, organizationId: 'org-9' }],
    ['a key of unknown type', { organizationId: 'org-9' }],
  ])('is null for %s, never a home org', (_label, info) => {
    expect(billedOrganizationIdForFreeze(info)).toBeNull();
  });
});
