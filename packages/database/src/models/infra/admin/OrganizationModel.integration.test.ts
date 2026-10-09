import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Organization, organizationRepository } from './OrganizationModel';

/**
 * Round-trip guard for the org-groups #1172 fields. `adminUserIds` is load-bearing for
 * authorization (assertCanManageOrgGroups reads it), so a strict-mode silent drop would fail OPEN
 * on writes and closed on reads - exactly the class GroupModel.integration.test guards for Group.
 */

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);
afterEach(async () => {
  await Organization.deleteMany({}, { hardDelete: true });
});

describe('OrganizationModel - org-groups fields', () => {
  it('persists adminUserIds and allowedGroupTypes (not dropped by strict mode)', async () => {
    const created = await Organization.create({
      name: 'Acme',
      userId: 'owner-1',
      personal: false,
      adminUserIds: ['admin-1', 'admin-2'],
      allowedGroupTypes: ['sales', 'research'],
    });

    // read straight from Mongo, not the in-memory doc, to prove it was actually stored
    const reloaded = await Organization.findById(created.id);
    expect(reloaded?.adminUserIds).toEqual(['admin-1', 'admin-2']);
    expect(reloaded?.allowedGroupTypes).toEqual(['sales', 'research']);
  });

  it('defaults adminUserIds and allowedGroupTypes to empty arrays (fail-closed)', async () => {
    const created = await Organization.create({ name: 'Bare', userId: 'owner-2', personal: false });
    const reloaded = await Organization.findById(created.id);
    expect(reloaded?.adminUserIds).toEqual([]);
    expect(reloaded?.allowedGroupTypes).toEqual([]);
  });
});

describe('OrganizationModel - findIdsWithAdminRights (#1668 org-manageable data lakes)', () => {
  it('returns orgs where the user is billing owner, manager, OR an appointed admin', async () => {
    const owned = await Organization.create({ name: 'Owned', userId: 'u1', personal: false });
    const managed = await Organization.create({ name: 'Managed', userId: 'other', managerId: 'u1', personal: false });
    const appointed = await Organization.create({
      name: 'Appointed',
      userId: 'other',
      adminUserIds: ['u1'],
      personal: false,
    });
    // A plain member (only on the users ACL, no admin role) is NOT administered.
    await Organization.create({ name: 'MemberOnly', userId: 'other', users: [{ userId: 'u1' }], personal: false });

    const ids = (await organizationRepository.findIdsWithAdminRights('u1')).sort();
    expect(ids).toEqual([owned.id, managed.id, appointed.id].sort());
  });

  it('returns an empty list for a user who administers nothing', async () => {
    await Organization.create({ name: 'Someone else', userId: 'other', personal: false });
    expect(await organizationRepository.findIdsWithAdminRights('nobody')).toEqual([]);
  });
});

describe('OrganizationModel - ensureUserDetails (#1460)', () => {
  it('seeds a zero-usage row for a member that has none', async () => {
    const org = await Organization.create({ name: 'Acme', userId: 'owner-1', personal: false, userDetails: [] });

    await organizationRepository.ensureUserDetails(org.id, {
      id: 'member-1',
      email: 'member1@example.com',
      name: 'Member One',
    });

    const reloaded = await Organization.findById(org.id);
    expect(reloaded?.userDetails).toHaveLength(1);
    expect(reloaded?.userDetails?.[0]).toMatchObject({
      id: 'member-1',
      email: 'member1@example.com',
      name: 'Member One',
      usedCredits: 0,
      lastCreditUsedAt: null,
    });
  });

  it('is idempotent and never overwrites an existing row (preserves usedCredits)', async () => {
    const org = await Organization.create({
      name: 'Acme',
      userId: 'owner-1',
      personal: false,
      userDetails: [
        { id: 'member-1', email: 'member1@example.com', name: 'Member One', usedCredits: 75, lastCreditUsedAt: null },
      ],
    });

    // A second seed for the same member must NOT reset their tracked usage or duplicate the row.
    await organizationRepository.ensureUserDetails(org.id, {
      id: 'member-1',
      email: 'changed@example.com',
      name: 'Changed Name',
    });

    const reloaded = await Organization.findById(org.id);
    expect(reloaded?.userDetails).toHaveLength(1);
    expect(reloaded?.userDetails?.[0]).toMatchObject({
      id: 'member-1',
      email: 'member1@example.com',
      name: 'Member One',
      usedCredits: 75,
    });
  });

  it('makes the positional updateUserDetails increment land where it previously no-oped', async () => {
    const org = await Organization.create({ name: 'Acme', userId: 'owner-1', personal: false, userDetails: [] });

    // Before seeding, the positional $inc matches no element and does nothing.
    await organizationRepository.updateUserDetails(org.id, 'member-1', { creditsDelta: 10 });
    let reloaded = await Organization.findById(org.id);
    expect(reloaded?.userDetails).toHaveLength(0);

    // After seeding, the same increment tracks against the member's row.
    await organizationRepository.ensureUserDetails(org.id, { id: 'member-1', email: 'm@example.com', name: 'M' });
    await organizationRepository.updateUserDetails(org.id, 'member-1', { creditsDelta: 10 });
    reloaded = await Organization.findById(org.id);
    expect(reloaded?.userDetails?.[0]).toMatchObject({ id: 'member-1', usedCredits: 10 });
  });
});

describe('OrganizationModel - updateUserDetails monthly budget period', () => {
  const october = new Date('2026-10-15T12:00:00Z');
  const octoberStart = new Date('2026-10-01T00:00:00Z');
  const member = (extra: Record<string, unknown>) => ({
    id: 'member-1',
    email: 'm@example.com',
    name: 'M',
    lastCreditUsedAt: null,
    ...extra,
  });
  const reloadRow = async (orgId: string, userId = 'member-1') =>
    (await Organization.findById(orgId))?.userDetails?.find(d => d.id === userId);

  it('accumulates within the current month without touching periodStart', async () => {
    const org = await Organization.create({
      name: 'Acme',
      userId: 'owner-1',
      personal: false,
      userDetails: [member({ usedCredits: 30, periodStart: octoberStart })],
    });

    await organizationRepository.updateUserDetails(org.id, 'member-1', { creditsDelta: 5 }, october);

    expect(await reloadRow(org.id)).toMatchObject({ usedCredits: 35, periodStart: octoberStart });
  });

  it('resets usage from an earlier month to the new delta and stamps the current period', async () => {
    const org = await Organization.create({
      name: 'Acme',
      userId: 'owner-1',
      personal: false,
      userDetails: [member({ usedCredits: 900, periodStart: new Date('2026-09-01T00:00:00Z') })],
    });

    const usedAt = new Date('2026-10-15T12:00:00Z');
    await organizationRepository.updateUserDetails(
      org.id,
      'member-1',
      { creditsDelta: 5, lastCreditUsedAt: usedAt },
      october
    );

    expect(await reloadRow(org.id)).toMatchObject({
      usedCredits: 5,
      periodStart: octoberStart,
      lastCreditUsedAt: usedAt,
    });
  });

  it('treats a legacy row with no periodStart as a stale lifetime counter and resets it', async () => {
    const org = await Organization.create({
      name: 'Acme',
      userId: 'owner-1',
      personal: false,
      userDetails: [member({ usedCredits: 900 })],
    });

    await organizationRepository.updateUserDetails(org.id, 'member-1', { creditsDelta: 5 }, october);

    expect(await reloadRow(org.id)).toMatchObject({ usedCredits: 5, periodStart: octoberStart });
  });

  it('touches only the target member and preserves their per-member override', async () => {
    const org = await Organization.create({
      name: 'Acme',
      userId: 'owner-1',
      personal: false,
      userDetails: [
        member({ usedCredits: 10, periodStart: octoberStart, maxCredits: 50 }),
        member({ id: 'member-2', usedCredits: 20, periodStart: octoberStart }),
      ],
    });

    await organizationRepository.updateUserDetails(org.id, 'member-1', { creditsDelta: 5 }, october);

    expect(await reloadRow(org.id)).toMatchObject({ usedCredits: 15, maxCredits: 50 });
    expect(await reloadRow(org.id, 'member-2')).toMatchObject({ usedCredits: 20 });
  });
});

describe('OrganizationModel - setMemberMaxCredits', () => {
  it('sets and clears one member override without touching usage or other members', async () => {
    const org = await Organization.create({
      name: 'Acme',
      userId: 'owner-1',
      personal: false,
      users: [
        { userId: 'member-1', permissions: ['read'] },
        { userId: 'member-2', permissions: ['read'] },
      ],
      userDetails: [
        { id: 'member-1', email: 'a@example.com', name: 'A', usedCredits: 7, lastCreditUsedAt: null },
        { id: 'member-2', email: 'b@example.com', name: 'B', usedCredits: 9, lastCreditUsedAt: null, maxCredits: 3 },
      ],
    });

    expect(await organizationRepository.setMemberMaxCredits(org.id, 'member-1', 40)).toBe(true);
    let reloaded = await Organization.findById(org.id);
    expect(reloaded?.userDetails?.[0]).toMatchObject({ id: 'member-1', usedCredits: 7, maxCredits: 40 });
    expect(reloaded?.userDetails?.[1]).toMatchObject({ id: 'member-2', usedCredits: 9, maxCredits: 3 });

    expect(await organizationRepository.setMemberMaxCredits(org.id, 'member-1', null)).toBe(true);
    reloaded = await Organization.findById(org.id);
    expect(reloaded?.userDetails?.[0]?.maxCredits).toBeNull();
  });

  it('reports false for a member with no row', async () => {
    const org = await Organization.create({ name: 'Acme', userId: 'owner-1', personal: false, userDetails: [] });
    expect(await organizationRepository.setMemberMaxCredits(org.id, 'member-1', 40)).toBe(false);
  });

  it('reports false and writes nothing for a userDetails row whose user is no longer owner, manager or a member', async () => {
    const org = await Organization.create({
      name: 'Acme',
      userId: 'owner-1',
      managerId: 'manager-1',
      personal: false,
      users: [{ userId: 'member-1', permissions: ['read'] }],
      userDetails: [{ id: 'removed-1', email: 'r@example.com', name: 'R', usedCredits: 4, lastCreditUsedAt: null }],
    });

    expect(await organizationRepository.setMemberMaxCredits(org.id, 'removed-1', 40)).toBe(false);
    const reloaded = await Organization.findById(org.id);
    expect(reloaded?.userDetails?.[0]?.maxCredits ?? null).toBeNull();
  });

  it('still sets an override for the appointed manager, who has no users[] row', async () => {
    const org = await Organization.create({
      name: 'Acme',
      userId: 'owner-1',
      managerId: 'mgr-1',
      personal: false,
      users: [],
      userDetails: [{ id: 'mgr-1', email: 'm@example.com', name: 'M', usedCredits: 0, lastCreditUsedAt: null }],
    });

    expect(await organizationRepository.setMemberMaxCredits(org.id, 'mgr-1', 40)).toBe(true);
    const reloaded = await Organization.findById(org.id);
    expect(reloaded?.userDetails?.[0]?.maxCredits).toBe(40);
  });

  it('still sets an override for the owner, who has no users[] row', async () => {
    const org = await Organization.create({
      name: 'Acme',
      userId: 'owner-1',
      personal: false,
      users: [],
      userDetails: [{ id: 'owner-1', email: 'o@example.com', name: 'O', usedCredits: 0, lastCreditUsedAt: null }],
    });

    expect(await organizationRepository.setMemberMaxCredits(org.id, 'owner-1', 40)).toBe(true);
    const reloaded = await Organization.findById(org.id);
    expect(reloaded?.userDetails?.[0]?.maxCredits).toBe(40);
  });
});
