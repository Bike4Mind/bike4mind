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
