import { describe, it, expect } from 'vitest';
import { Organization, organizationRepository } from './OrganizationModel';
import { setupMongoTest } from '../../../__test__/utils';

const makeOrg = (name: string, extra: Record<string, unknown> = {}) =>
  Organization.create({ name, userId: 'someone-else', users: [], groups: [], ...extra });

describe('OrganizationRepository.findMembershipOrgIds', () => {
  setupMongoTest();

  it('returns orgs where the user is the owner', async () => {
    const owned = await makeOrg('owned', { userId: 'u1' });
    await makeOrg('other');
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([String(owned._id)]);
  });

  it('returns orgs where the user is in the users[] ACL with read permission', async () => {
    const member = await makeOrg('member-org', {
      users: [{ userId: 'u1', permissions: ['read'] }],
    });
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([String(member._id)]);
  });

  it('excludes an ACL row without read/write permission', async () => {
    await makeOrg('share-only', { users: [{ userId: 'u1', permissions: ['share'] }] });
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([]);
  });

  it('returns [] for a user in no org, and both arms together deduplicated', async () => {
    expect(await organizationRepository.findMembershipOrgIds('nobody')).toEqual([]);
    const both = await makeOrg('own-and-listed', {
      userId: 'u1',
      users: [{ userId: 'u1', permissions: ['read'] }],
    });
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([String(both._id)]);
  });
});
