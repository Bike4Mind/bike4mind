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

  it('excludes a soft-deleted org even though the user is still a member', async () => {
    const deleted = await makeOrg('soft-deleted', { users: [{ userId: 'u1', permissions: ['read'] }] });
    // Mirrors softDeletePlugin's own mechanism (raw-driver updateOne, see mongo.ts) rather than
    // calling a model method, so this test exercises the plugin's `pre('find')` filter, not its
    // own delete statics.
    await Organization.collection.updateOne({ _id: deleted._id }, { $set: { deletedAt: new Date() } });
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([]);
  });
});

describe('OrganizationRepository.search - users[] ACL membership arm', () => {
  setupMongoTest();

  const searchByUser = async (userId: string) =>
    (
      await organizationRepository.search('', { userId }, { page: 1, limit: 10 }, { field: 'name', direction: 'asc' })
    ).data.map(d => String(d._id));

  it('a write-only ACL member finds the org (same predicate as findMembershipOrgIds)', async () => {
    // Raw insert because no app write path can produce a write-only ACL row (writers hard-code
    // ['read']) - the predicate is defensive against legacy/out-of-band data, and the schema
    // enum must stay untouched.
    const result = await Organization.collection.insertOne({
      name: 'write-only-search',
      userId: 'someone-else',
      users: [{ userId: 'u1', permissions: ['write'] }],
      groups: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const orgId = String(result.insertedId);
    expect(await searchByUser('u1')).toEqual([orgId]);
    // The read-side set must agree - the whole point of the shared constant.
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([orgId]);
  });

  it('a user with no ACL entry and no ownership matches nothing', async () => {
    await makeOrg('unrelated', { users: [{ userId: 'someone', permissions: ['read'] }] });
    expect(await searchByUser('u1')).toEqual([]);
  });
});
