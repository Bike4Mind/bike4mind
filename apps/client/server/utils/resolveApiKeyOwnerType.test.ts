import { describe, expect, it } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import { resolveApiKeyOwnerType } from './resolveApiKeyOwnerType';

describe('resolveApiKeyOwnerType', () => {
  it('is organization only for an org-billed key that has an organization id', () => {
    expect(resolveApiKeyOwnerType({ billingOwnerType: CreditHolderType.Organization, organizationId: 'org-1' })).toBe(
      CreditHolderType.Organization
    );
  });

  it('falls back to user when an org-billed key has no organization id', () => {
    expect(resolveApiKeyOwnerType({ billingOwnerType: CreditHolderType.Organization })).toBe(CreditHolderType.User);
    expect(resolveApiKeyOwnerType({ billingOwnerType: CreditHolderType.Organization, organizationId: null })).toBe(
      CreditHolderType.User
    );
  });

  it('is user for a user-billed key even when it carries an organization id', () => {
    expect(resolveApiKeyOwnerType({ billingOwnerType: CreditHolderType.User, organizationId: 'org-1' })).toBe(
      CreditHolderType.User
    );
  });
});
