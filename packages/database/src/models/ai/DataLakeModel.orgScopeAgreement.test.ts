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
 *    BOTH lake write paths - create and visibility promotion - get their org id
 *    (`activeOrgId()` -> `resolveActiveOrg`).
 *  - `organizationRepository.findMembershipOrgIds` backs `AccessContext.organizationIds`, which is
 *    the org arm of `findAccessible` - the manager list's filter.
 * When they disagreed, a lake created in a switched-to org was invisible in its creator's own
 * manager (#1648, root-caused to the read path scoping by the `user.organizationId` POINTER).
 *
 * So this file composes the real repositories the way the request path does rather than asserting
 * on either predicate alone: the bug lived in the seam between them, not inside either one.
 *
 * The org half of the invariant - that the two predicates return the SAME set, so a selectable org
 * is never an unlistable one - is pinned next to those predicates in
 * `OrganizationModel.membershipOrgIds.test.ts`. Keep the two in mind together: this file proves the
 * lake read path honors the membership set, that one proves the set matches what the switcher offers.
 *
 * #2005 is the second half of the same idea on the other authority: the read path must also honor
 * the org-ADMIN set, because `canManageLake` grants manage (and so read) on it. Same seam, same
 * failure mode - a principal the write/manage path authorizes cannot find what it authorized them
 * for - so the cases live here rather than in a third file.
 */

const orgLake = (
  slug: string,
  organizationId: string,
  createdByUserId: string,
  extra: Partial<IDataLake> = {}
): Omit<IDataLake, 'id'> =>
  ({
    slug,
    name: slug,
    fileTagPrefix: `${slug}:`,
    datalakeTag: `datalake:${slug}`,
    createdByUserId,
    status: 'active',
    organizationId,
    ...extra,
  }) as Omit<IDataLake, 'id'>;

/**
 * The manager list's AccessContext, built the way `toAccessContext` builds it: `organizationIds`
 * from the membership set, `administeredOrgIds` from the org-admin-rights set, and no selected-org
 * pointer because the production context has nowhere to put one - which is the #1648 fix.
 *
 * Both sets come from the real repositories on purpose. Hardcoding `administeredOrgIds: []` here is
 * what let #2005 sit uncovered: every case in this file described a principal whose admin set was
 * empty anyway, so the missing org-admin arm never had a test that could see it.
 */
const listContext = async (userId: string): Promise<AccessContext> => ({
  userId,
  isAdmin: false,
  userTags: [],
  organizationIds: await organizationRepository.findMembershipOrgIds(userId),
  entitlementKeys: [],
  administeredOrgIds: await organizationRepository.findIdsWithAdminRights(userId),
});

const listableSlugs = async (userId: string) =>
  (await dataLakeRepository.findAccessible(await listContext(userId))).map(l => l.slug).sort();

describe('data-lake org scope: the manager list agrees with what the org grants (#1648, #2005)', () => {
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

  /**
   * The org-ADMIN half of the same seam (#2005). `canManageLake` rung 4 admits an admin of the
   * lake's own org, and `classifyLakeAccess` runs that rung BEFORE its org prerequisite, so such a
   * principal could open, review and approve an org lake while `findAccessible` left it out of the
   * only list that leads there. Manage implies read; these pin that the datastore mirror says so too.
   *
   * The admin set (`findIdsWithAdminRights`: billing owner OR managerId OR adminUserIds) is WIDER
   * than the membership set above and stays a separate set - see the note on `orgMembershipFilter`
   * for why folding these arms into membership instead would have changed a write privilege.
   */
  /** An org whose admin rights `admin` holds without any `users[]` ACL row conferring membership. */
  const orgWithManager = (name: string, manager: string) =>
    Organization.create({ name, userId: 'org-owner', managerId: manager, users: [], groups: [] });

  it('lists an org lake for a team manager who sits on no users[] ACL row', async () => {
    const orgA = await orgWithManager('org-a', 'manager');
    await dataLakeRepository.create(orgLake('a-lake', String(orgA._id), 'creator'));

    expect(await listableSlugs('manager')).toEqual(['a-lake']);
  });

  it('lists an org lake for an appointed admin whose ACL row carries no permissions', async () => {
    // `PUT /api/organizations/:id/admins` now refuses to MINT this shape - it requires an ACL row
    // that confers membership. The state is still reachable, which is why the case stays: rows
    // appointed before that check existed persist, and the route grandfathers them on resend rather
    // than revoking retroactively. So the datastore really does hold admin rights with no membership.
    const orgA = await Organization.create({
      name: 'org-a',
      userId: 'org-owner',
      users: [{ userId: 'appointee' }],
      adminUserIds: ['appointee'],
      groups: [],
    });
    await dataLakeRepository.create(orgLake('a-lake', String(orgA._id), 'creator'));

    expect(await listableSlugs('appointee')).toEqual(['a-lake']);
  });

  it('lists a gated org lake for its org admin, whose rights outrank the gate', async () => {
    // Load-bearing for the arm's SHAPE, not just its presence: the org-admin arm is unconstrained,
    // like the owner arm. An implementation that ANDed the requirement onto it would pass every
    // other case here and still hide this lake - which the gate opens, since canManageLake resolves
    // before lakeMatchesAccess is ever consulted.
    const orgA = await orgWithManager('org-a', 'manager');
    await dataLakeRepository.create(
      orgLake('a-lake', String(orgA._id), 'creator', { requiredUserTag: 'tag-the-manager-lacks' })
    );

    expect(await listableSlugs('manager')).toEqual(['a-lake']);
  });

  it('lists an archived org lake for its org admin, so restore/cleanup can reach it', async () => {
    // The management views pass includePublic:false because restore/cleanup are owner/admin-only.
    // An org admin is in that class, so the arm must survive there too.
    const orgA = await orgWithManager('org-a', 'manager');
    await dataLakeRepository.create(orgLake('a-lake', String(orgA._id), 'creator', { status: 'archived' }));

    const archived = await dataLakeRepository.findAccessible(await listContext('manager'), {
      statuses: ['archived'],
      includePublic: false,
    });
    expect(archived.map(l => l.slug)).toEqual(['a-lake']);
  });

  it('does not turn admin rights into membership, so the account switcher is unaffected', async () => {
    // The anti-regression for the fix NOT taken. Widening `orgMembershipFilter` would have listed
    // the lake too, and also handed `manager` the org as a selectable write target via
    // `resolveActiveOrg`. Membership must stay ACL-only while the lake still lists.
    const orgA = await orgWithManager('org-a', 'manager');
    await dataLakeRepository.create(orgLake('a-lake', String(orgA._id), 'creator'));

    expect(await organizationRepository.findMembershipOrgIds('manager')).toEqual([]);
    expect(await organizationRepository.findIdsWithAdminRights('manager')).toEqual([String(orgA._id)]);
    expect(await listableSlugs('manager')).toEqual(['a-lake']);
  });

  it('still hides an org lake from an admin of a different org (the arm is scoped, not disabled)', async () => {
    const orgA = await orgWithManager('org-a', 'manager');
    const orgB = await orgWithManager('org-b', 'other-manager');
    await dataLakeRepository.create(orgLake('a-lake', String(orgA._id), 'creator'));
    await dataLakeRepository.create(orgLake('b-lake', String(orgB._id), 'creator'));

    expect(await listableSlugs('manager')).toEqual(['a-lake']);
  });
});
