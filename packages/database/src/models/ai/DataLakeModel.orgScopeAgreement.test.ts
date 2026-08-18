import { describe, it, expect } from 'vitest';
import type { AccessContext, IDataLake } from '@bike4mind/common';
import { dataLakeRepository } from './DataLakeModel';
import { Organization, organizationRepository } from '../infra/admin/OrganizationModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * The org-scope AGREEMENT invariant (#1648): an org a user can select in the account switcher
 * must be an org whose lakes that user can list, and a lake stamped with the org the write path
 * validated must be visible to the read path.
 *
 * These are two independent predicates in production that have to describe the same membership:
 *  - `organizationRepository.search({ userId })` backs the account-switcher list, which is where
 *    the create path's org id comes from (`activeOrgId()` -> `resolveActiveOrg`).
 *  - `organizationRepository.findMembershipOrgIds` backs `AccessContext.organizationIds`, which is
 *    the org arm of `findAccessible` - the manager list's filter.
 * When they disagreed, a lake created in a switched-to org was invisible in its creator's own
 * manager (#1648, root-caused to the read path scoping by the `user.organizationId` POINTER).
 *
 * So this file composes the real repositories the way the request path does rather than asserting
 * on either predicate alone: the bug lived in the seam between them, not inside either one.
 */

const orgLake = (slug: string, organizationId: string, createdByUserId: string): Omit<IDataLake, 'id'> =>
  ({
    slug,
    name: slug,
    fileTagPrefix: `${slug}:`,
    datalakeTag: `datalake:${slug}`,
    createdByUserId,
    status: 'active',
    organizationId,
  }) as Omit<IDataLake, 'id'>;

/**
 * The manager list's AccessContext, built the way `toAccessContext` builds it: `organizationIds`
 * comes from the membership set and nothing else. Callers pass no selected-org pointer because the
 * production context has nowhere to put one - which is the fix being pinned.
 */
const listContext = async (userId: string): Promise<AccessContext> => ({
  userId,
  isAdmin: false,
  userTags: [],
  organizationIds: await organizationRepository.findMembershipOrgIds(userId),
  entitlementKeys: [],
  administeredOrgIds: [],
});

const listableSlugs = async (userId: string) =>
  (await dataLakeRepository.findAccessible(await listContext(userId))).map(l => l.slug).sort();

describe('data-lake org scope: switcher selection agrees with the manager list (#1648)', () => {
  setupMongoTest();

  /** An org the switcher offers `member` (ACL arm), owned by someone else. */
  const orgWithMember = (name: string, member: string) =>
    Organization.create({ name, userId: 'org-owner', users: [{ userId: member, permissions: ['read'] }], groups: [] });

  it('lists a lake created in the switched-to org for a member who did NOT create it', async () => {
    // The load-bearing case. The creator would pass via findAccessible's `createdByUserId` owner
    // arm no matter what the org arm did, so testing only the creator cannot tell a working org
    // arm from a broken one. A non-creator member exercises the org arm alone.
    const orgA = await orgWithMember('org-a', 'member');
    const orgB = await orgWithMember('org-b', 'member');
    await dataLakeRepository.create(orgLake('a-lake', String(orgA._id), 'creator'));
    await dataLakeRepository.create(orgLake('b-lake', String(orgB._id), 'creator'));

    // Both orgs are selectable in the switcher, so both orgs' lakes must list - regardless of
    // which one is currently selected, which the read path no longer has any way to consult.
    expect(await listableSlugs('member')).toEqual(['a-lake', 'b-lake']);
  });

  it('lists the lake for its creator under a switched-to org (the reported repro)', async () => {
    const orgA = await orgWithMember('org-a', 'creator');
    await dataLakeRepository.create(orgLake('a-lake', String(orgA._id), 'creator'));

    expect(await listableSlugs('creator')).toEqual(['a-lake']);
  });

  it('still hides an org lake from a non-member (the filter is scoped, not disabled)', async () => {
    // Guards against the opposite failure: "every lake lists for everyone" would satisfy the
    // assertions above while destroying the org boundary.
    const orgA = await orgWithMember('org-a', 'member');
    await dataLakeRepository.create(orgLake('a-lake', String(orgA._id), 'creator'));

    expect(await listableSlugs('stranger')).toEqual([]);
  });

  it('admits every org the switcher offers, so a selectable org is never an unlistable one', async () => {
    // The invariant that makes the two predicates safe to keep separate. Fixture spans all four
    // membership shapes so a new arm added to one predicate and not the other fails here.
    const owned = await Organization.create({ name: 'owned', userId: 'u1', users: [], groups: [] });
    const viaAcl = await orgWithMember('via-acl', 'u1');
    await Organization.create({ name: 'unrelated', userId: 'someone-else', users: [], groups: [] });
    // Group-mediated only: absent from BOTH predicates today. Pinned so that widening the
    // switcher to group membership without widening the read set (or vice versa) fails loudly -
    // that is precisely the drift that produced #1648.
    await Organization.create({
      name: 'via-group',
      userId: 'someone-else',
      users: [],
      groups: [{ groupId: 'g1', permissions: ['read'] }],
    });

    const switcherOrgIds = (
      await organizationRepository.search(
        '',
        { userId: 'u1' },
        { page: 1, limit: 100 },
        {
          field: 'name',
          direction: 'asc',
        }
      )
    ).data
      .map(o => String(o.id ?? o._id))
      .sort();
    const readableOrgIds = (await organizationRepository.findMembershipOrgIds('u1')).sort();

    expect(switcherOrgIds).toEqual([String(owned._id), String(viaAcl._id)].sort());
    expect(readableOrgIds).toEqual(switcherOrgIds);
  });
});
