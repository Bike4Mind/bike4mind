import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { assertNotOrgServiceAccount } from './assertNotOrgServiceAccount';

describe('assertNotOrgServiceAccount', () => {
  it('refuses an organization service account', () => {
    expect(() => assertNotOrgServiceAccount({ serviceAccountOrganizationId: 'org-1' })).toThrow(ForbiddenError);
  });

  it.each([
    ['a member', { serviceAccountOrganizationId: undefined }],
    ['a member with a null binding', { serviceAccountOrganizationId: null }],
    ['no user', undefined],
  ])('lets %s through', (_label, user) => {
    expect(() => assertNotOrgServiceAccount(user)).not.toThrow();
  });
});
