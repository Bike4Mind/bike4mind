import { describe, expect, it } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import { spendFreezeSubjectForHold } from './spendFreezeSubjectForHold';

describe('spendFreezeSubjectForHold', () => {
  const base = { userId: 'u1', organizationId: 'o1', apiKeyId: 'k1' };

  it('leaves the creator out only for an org-billed key', () => {
    expect(spendFreezeSubjectForHold({ ...base, apiKeyBillingOwnerType: CreditHolderType.Organization })).toEqual({
      userId: null,
      organizationId: 'o1',
      apiKeyId: 'k1',
    });
  });

  it('keeps the owner for a user-billed key that spends on an organization', () => {
    expect(spendFreezeSubjectForHold({ ...base, apiKeyBillingOwnerType: CreditHolderType.User }).userId).toBe('u1');
  });

  it('keeps the user when the key type is unknown', () => {
    expect(spendFreezeSubjectForHold(base).userId).toBe('u1');
  });

  it('keeps the user when there is no key, whatever the type says', () => {
    expect(
      spendFreezeSubjectForHold({
        userId: 'u1',
        organizationId: 'o1',
        apiKeyBillingOwnerType: CreditHolderType.Organization,
      }).userId
    ).toBe('u1');
  });
});
