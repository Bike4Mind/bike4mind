import { describe, expect, it, vi } from 'vitest';
import { BadRequestError, type IOrganizationDocument } from '@bike4mind/common';

vi.mock('@bike4mind/services', async () => ({
  organizationService: await import('../../../../b4m-core/services/src/organizationService/orgAuthority'),
}));

import { assertApiKeyOrgMembership } from './assertApiKeyOrgMembership';

const org = (users: string[]) =>
  ({ id: 'org1', userId: 'owner', users: users.map(userId => ({ userId })) }) as unknown as IOrganizationDocument;
const member = { id: 'u1', isAdmin: false };

describe('assertApiKeyOrgMembership', () => {
  it.each([
    ['a member using an org-billed key', org(['u1']), member, true],
    ['a platform admin off the roster', org([]), { id: 'u1', isAdmin: true }, true],
    ['a JWT caller off the roster', org([]), member, false],
    ['a user-billed key (no billing org)', null, member, true],
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
});
