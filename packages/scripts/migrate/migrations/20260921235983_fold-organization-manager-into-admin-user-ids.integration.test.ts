import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { canAdministerOrganization } from '@bike4mind/common';
import { Organization, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235983_fold-organization-manager-into-admin-user-ids';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const OWNER_ID = new mongoose.Types.ObjectId().toString();

let server: Awaited<ReturnType<typeof createMongoServer>>;

const insertManager = async (fields: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, email: `manager-${_id}@example.com`, name: 'Manager', ...fields });
  return _id.toString();
};

const readUser = async (id: string) => User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

const insertOrganization = async (fields: Record<string, unknown>) => {
  const _id = new mongoose.Types.ObjectId();
  await Organization.collection.insertOne({
    _id,
    name: 'Team',
    userId: OWNER_ID,
    users: [],
    userDetails: [],
    adminUserIds: [],
    ...fields,
  });
  return _id;
};

const readOrganization = async (_id: mongoose.Types.ObjectId) => {
  const organization = await Organization.collection.findOne({ _id });
  if (!organization) throw new Error('organization vanished');
  return organization;
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await Organization.collection.drop().catch(() => {});
  await User.collection.drop().catch(() => {});
});

describe('fold-organization-manager-into-admin-user-ids migration (real DB)', () => {
  it('folds the manager into adminUserIds with a read row and a credit row, and unsets managerId', async () => {
    const managerId = await insertManager();
    const orgId = await insertOrganization({ managerId });

    await migration.up();

    const organization = await readOrganization(orgId);
    expect(organization).not.toHaveProperty('managerId');
    expect(organization.adminUserIds).toEqual([managerId]);
    expect(organization.users).toEqual([{ userId: managerId, permissions: ['read'] }]);
    expect(organization.userDetails).toEqual([
      expect.objectContaining({ id: managerId, name: 'Manager', usedCredits: 0 }),
    ]);
  });

  it('points an unpointed manager at the org but keeps an existing pointer', async () => {
    const unpointedId = await insertManager();
    const otherOrgId = new mongoose.Types.ObjectId();
    const pointedId = await insertManager({ organizationId: otherOrgId });
    const firstOrgId = await insertOrganization({ managerId: unpointedId });
    await insertOrganization({ managerId: pointedId });

    await migration.up();

    expect((await readUser(unpointedId))?.organizationId).toEqual(firstOrgId);
    expect((await readUser(pointedId))?.organizationId).toEqual(otherOrgId);
  });

  it('logs an org the fold pushes over its seat count, and still folds the manager', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const managerId = await insertManager();
    const orgId = await insertOrganization({
      managerId,
      seats: 2,
      users: [{ userId: new mongoose.Types.ObjectId().toString(), permissions: ['read'] }],
    });

    await migration.up();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`org ${orgId.toString()} now uses 3 of 2 seats`));
    expect((await readOrganization(orgId)).adminUserIds).toEqual([managerId]);
    warn.mockRestore();
  });

  it('completes a partial prior run without duplicating rows', async () => {
    const managerId = await insertManager();
    const orgId = await insertOrganization({
      managerId,
      users: [{ userId: managerId, permissions: ['read'] }],
    });

    await migration.up();

    const organization = await readOrganization(orgId);
    expect(organization).not.toHaveProperty('managerId');
    expect(organization.adminUserIds).toEqual([managerId]);
    expect(organization.users).toHaveLength(1);
    expect(organization.userDetails).toHaveLength(1);
  });

  it('keeps the migrated manager able to administer the org', async () => {
    const managerId = await insertManager();
    const orgId = await insertOrganization({ managerId });

    await migration.up();

    const organization = await readOrganization(orgId);
    expect(
      canAdministerOrganization(
        { id: managerId },
        { userId: OWNER_ID, adminUserIds: organization.adminUserIds, users: organization.users }
      )
    ).toBe(true);
  });

  it('leaves an existing roster row, credit row and adminUserIds entry untouched', async () => {
    const managerId = await insertManager();
    const existingRow = { userId: managerId, permissions: ['read', 'write'] };
    const existingDetails = { id: managerId, email: 'kept@example.com', name: 'Kept', usedCredits: 42 };
    const orgId = await insertOrganization({
      managerId,
      adminUserIds: [managerId],
      users: [existingRow],
      userDetails: [existingDetails],
    });

    await migration.up();

    const organization = await readOrganization(orgId);
    expect(organization.adminUserIds).toEqual([managerId]);
    expect(organization.users).toEqual([existingRow]);
    expect(organization.userDetails).toEqual([existingDetails]);
  });

  it('gives an existing roster row with no membership permission the read permission', async () => {
    const managerId = await insertManager();
    const orgId = await insertOrganization({
      managerId,
      users: [{ userId: managerId, permissions: [] }],
    });

    await migration.up();

    expect((await readOrganization(orgId)).users).toEqual([{ userId: managerId, permissions: ['read'] }]);
  });

  it('only unsets a managerId that is the billing owner or names a missing or soft-deleted user', async () => {
    const ownerManagedId = await insertOrganization({ managerId: OWNER_ID });
    const danglingId = await insertOrganization({ managerId: new mongoose.Types.ObjectId().toString() });
    const deletedManagerId = await insertManager({ deletedAt: new Date() });
    const deletedId = await insertOrganization({ managerId: deletedManagerId });
    const nullId = await insertOrganization({ managerId: null });

    await migration.up();

    for (const orgId of [ownerManagedId, danglingId, deletedId, nullId]) {
      const organization = await readOrganization(orgId);
      expect(organization).not.toHaveProperty('managerId');
      expect(organization.adminUserIds).toEqual([]);
      expect(organization.users).toEqual([]);
    }
  });

  it('folds a soft-deleted organization too', async () => {
    const managerId = await insertManager();
    const orgId = await insertOrganization({ managerId, deletedAt: new Date() });

    await migration.up();

    const organization = await readOrganization(orgId);
    expect(organization).not.toHaveProperty('managerId');
    expect(organization.adminUserIds).toEqual([managerId]);
  });

  it('drops the managerId index and is idempotent on re-run', async () => {
    const managerId = await insertManager();
    const orgId = await insertOrganization({ managerId });
    await Organization.collection.createIndex({ managerId: 1 }, { name: 'engine_specific_name' });

    await migration.up();
    await migration.up();

    const keys = (await Organization.collection.indexes()).map(index => index.key);
    expect(keys).not.toContainEqual({ managerId: 1 });
    const organization = await readOrganization(orgId);
    expect(organization.adminUserIds).toEqual([managerId]);
    expect(organization.users).toHaveLength(1);
    expect(organization.userDetails).toHaveLength(1);
  });

  it('runs on a database that never created the organizations collection', async () => {
    await expect(migration.up()).resolves.toBeUndefined();
  });
});
