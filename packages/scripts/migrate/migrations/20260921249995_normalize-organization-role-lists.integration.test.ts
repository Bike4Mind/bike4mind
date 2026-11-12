import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  ORG_PERMISSIONS,
  hasOrgPermission,
  organizationMemberRole,
  type OrgPermission,
  type OrgRoleSubject,
} from '@bike4mind/common';
import { Organization, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921249995_normalize-organization-role-lists';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const OWNER = 'owner-1';
const MANAGER = 'manager-1';
const MEMBER = 'member-1';
const STALE_MANAGER = 'stale-manager-1';

const rawOrganizations = () => Organization.db.collection(Organization.collection.collectionName);

const seed = async (fields: Record<string, unknown>) => {
  const { insertedId } = await rawOrganizations().insertOne({
    name: 'Team',
    userId: OWNER,
    users: [
      { userId: MANAGER, permissions: ['read'] },
      { userId: MEMBER, permissions: ['read'] },
    ],
    ...fields,
  });
  return insertedId;
};

const load = async (id: mongoose.Types.ObjectId) => {
  const doc = await rawOrganizations().findOne({ _id: id });
  if (!doc) throw new Error('seeded organization vanished');
  return doc as unknown as OrgRoleSubject;
};

/** Every (user, permission) pair's answer - the capability fingerprint the migration must preserve. */
const capabilities = (org: OrgRoleSubject) =>
  [OWNER, MANAGER, MEMBER, STALE_MANAGER, 'outsider'].flatMap(userId =>
    ORG_PERMISSIONS.map((permission: OrgPermission) => ({
      userId,
      permission,
      allowed: hasOrgPermission({ id: userId }, org, permission),
    }))
  );

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Organization.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.createCollection(Organization.collection.collectionName).catch(() => {});
  await rawOrganizations().deleteMany({});
  await safeDropIndex(Organization.collection, 'billingManagerUserIds_1');
});

describe('normalize-organization-role-lists migration (real DB)', () => {
  it('maps the owner to Owner and managers to Manager without changing any capability', async () => {
    const id = await seed({ adminUserIds: [OWNER, MANAGER, STALE_MANAGER] });
    const before = capabilities(await load(id));

    await migration.up();

    const after = await load(id);
    expect(capabilities(after)).toEqual(before);
    expect(organizationMemberRole(after, OWNER)).toBe('owner');
    expect(organizationMemberRole(after, MANAGER)).toBe('manager');
    expect(organizationMemberRole(after, MEMBER)).toBe('member');
    // No roster row, so no role before or after; the entry itself is left for the purge paths.
    expect(organizationMemberRole(after, STALE_MANAGER)).toBeNull();
    expect(after.adminUserIds).toEqual([MANAGER, STALE_MANAGER]);
    expect(after.billingManagerUserIds).toEqual([]);
  });

  it('drops an owner entry stored as an ObjectId', async () => {
    const ownerObjectId = new mongoose.Types.ObjectId();
    const id = await seed({ userId: ownerObjectId.toString(), adminUserIds: [ownerObjectId, MANAGER] });

    await migration.up();

    expect((await load(id)).adminUserIds).toEqual([MANAGER]);
  });

  it('turns missing and null role lists into empty lists', async () => {
    const missing = await seed({});
    const nulls = await seed({ adminUserIds: null, billingManagerUserIds: null });

    await migration.up();

    for (const id of [missing, nulls]) {
      const org = await load(id);
      expect(org.adminUserIds).toEqual([]);
      expect(org.billingManagerUserIds).toEqual([]);
    }
  });

  it('leaves an existing billing manager list alone', async () => {
    const id = await seed({ adminUserIds: [MANAGER], billingManagerUserIds: [MEMBER] });

    await migration.up();

    expect((await load(id)).billingManagerUserIds).toEqual([MEMBER]);
  });

  it('builds the billing manager index and is idempotent', async () => {
    const id = await seed({ adminUserIds: [OWNER, MANAGER] });

    await migration.up();
    const once = await load(id);
    await migration.up();

    expect(await load(id)).toEqual(once);
    const index = (await Organization.collection.indexes()).find(i => i.name === 'billingManagerUserIds_1');
    expect(index).toBeDefined();
  });
});
