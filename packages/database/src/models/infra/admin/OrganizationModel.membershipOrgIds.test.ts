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

  it('returns the SAME set as findMembershipOrgIds across every membership shape (#1648)', async () => {
    // search() backs the account-switcher list, which is where the data-lake write paths get the
    // org id they stamp; findMembershipOrgIds backs the read scope that decides which org lakes
    // list. An org present in one but not the other is selectable-but-unlistable - that
    // disagreement is what made a lake created in a switched-to org invisible in its creator's own
    // manager (#1648). The fixture spans all four shapes so widening one predicate's arms without
    // the other fails here rather than in the manager.
    const owned = await makeOrg('owned', { userId: 'u1' });
    const viaAcl = await makeOrg('via-acl', { users: [{ userId: 'u1', permissions: ['read'] }] });
    await makeOrg('unrelated-org');
    // Group-mediated only: absent from BOTH predicates today. The write-side validator
    // (resolveActiveOrg -> shareable.findAccessibleById) DOES accept it, so this row is what would
    // change shape first if that wider predicate ever became the read predicate too.
    await makeOrg('via-group', { groups: [{ groupId: 'g1', permissions: ['read'] }] });

    // Both sides sorted: searchByUser returns name-ordered rows, so comparing raw would pin
    // incidental ordering rather than set equality, which is what the invariant is about.
    const expected = [String(owned._id), String(viaAcl._id)].sort();
    expect((await searchByUser('u1')).sort()).toEqual(expected);
    expect((await organizationRepository.findMembershipOrgIds('u1')).sort()).toEqual(expected);
  });
});
