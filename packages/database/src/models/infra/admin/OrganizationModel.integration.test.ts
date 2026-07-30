import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Organization } from './OrganizationModel';

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
