import { describe, expect, it, vi } from 'vitest';
import { BadRequestError, type IOrganizationDocument } from '@bike4mind/common';

vi.mock('@bike4mind/services', async () => ({
  organizationService: await import('../../../../b4m-core/services/src/organizationService/orgAuthority'),
}));

import { assertApiKeyOrgMembership } from './assertApiKeyOrgMembership';
import { withholdAdminRole } from '../auth/apiKeyAdminScope';

const org = (users: string[]) =>
  ({ id: 'org1', userId: 'owner', users: users.map(userId => ({ userId })) }) as unknown as IOrganizationDocument;
const member = { id: 'u1', isAdmin: false };
const serviceAccountOf = (organizationId: string) => ({
  id: 'sa1',
  isAdmin: false,
  isSystem: true,
  serviceAccountOrganizationId: organizationId,
});

describe('assertApiKeyOrgMembership', () => {
  it('admits a non-seat service principal only for its own organization', () => {
    const billingUser = {
      id: 'service',
      isAdmin: false,
      isSystem: true,
      serviceAccountOrganizationId: 'org1',
    };
    expect(() => assertApiKeyOrgMembership({ billingOrg: org([]), billingUser, isApiKeyCaller: true })).not.toThrow();
    expect(() =>
      assertApiKeyOrgMembership({
        billingOrg: org([]),
        billingUser: {
          ...billingUser,
          serviceAccountOrganizationId: 'other',
        },
        isApiKeyCaller: true,
      })
    ).toThrow(BadRequestError);
  });
  it.each([
    ['a member using an org-billed key', org(['u1']), member, true],
    ['a platform admin off the roster', org([]), { id: 'u1', isAdmin: true }, true],
    ['a platform admin whose key lacks the admin scope', org([]), withholdAdminRole({ id: 'u1', isAdmin: true }), true],
    ['a JWT caller off the roster', org([]), member, false],
    ['a user-billed key (no billing org)', null, member, true],
    ["the org's own service account, never on the roster", org([]), serviceAccountOf('org1'), true],
  ])('admits %s', (_label, billingOrg, billingUser, isApiKeyCaller) => {
    expect(() => assertApiKeyOrgMembership({ billingOrg, billingUser, isApiKeyCaller })).not.toThrow();
  });

  it('refuses an org-billed key whose holder left the org, as a 400', () => {
    const refuse = () => assertApiKeyOrgMembership({ billingOrg: org([]), billingUser: member, isApiKeyCaller: true });

    expect(refuse).toThrow(BadRequestError);
    expect(refuse).toThrow(
      expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/no longer a member/) })
    );
  });

  it.each([
    ["another org's service account", serviceAccountOf('org2')],
    ['a non-system user claiming the service-account org', { ...serviceAccountOf('org1'), isSystem: false }],
  ])('refuses %s', (_label, billingUser) => {
    expect(() => assertApiKeyOrgMembership({ billingOrg: org([]), billingUser, isApiKeyCaller: true })).toThrow(
      BadRequestError
    );
  });
});
