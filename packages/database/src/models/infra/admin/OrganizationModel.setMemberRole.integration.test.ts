import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { Permission } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Organization, organizationRepository } from './OrganizationModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await Organization.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const member = (userId: string) => ({ userId, permissions: [Permission.read] });

const roleLists = async (id: string) => {
  const after = await Organization.findById(id).lean();
  return { managers: after!.adminUserIds, billingManagers: after!.billingManagerUserIds };
};

describe('OrganizationModel.setMemberRole', () => {
  it('makes a member a manager without touching the sitting managers', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('a'), member('b')],
      adminUserIds: ['a'],
    });

    expect(await organizationRepository.setMemberRole(created.id, 'b', 'manager')).toBe(true);

    expect(await roleLists(created.id)).toEqual({ managers: ['a', 'b'], billingManagers: [] });
  });

  it('moves a manager to billing manager, keeping the lists disjoint', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('a'), member('b')],
      adminUserIds: ['a', 'b'],
    });

    expect(await organizationRepository.setMemberRole(created.id, 'a', 'billingManager')).toBe(true);

    expect(await roleLists(created.id)).toEqual({ managers: ['b'], billingManagers: ['a'] });
  });

  it('demotes to member by clearing both lists, and leaves the roster row alone', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('a'), member('b')],
      adminUserIds: ['a'],
      billingManagerUserIds: ['a', 'b'],
    });

    expect(await organizationRepository.setMemberRole(created.id, 'a', 'member')).toBe(true);

    expect(await roleLists(created.id)).toEqual({ managers: [], billingManagers: ['b'] });
    expect((await Organization.findById(created.id).lean())!.users.map(u => u.userId)).toEqual(['a', 'b']);
  });

  it('is idempotent for a role the member already holds', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('a')],
      adminUserIds: ['a'],
    });

    expect(await organizationRepository.setMemberRole(created.id, 'a', 'manager')).toBe(true);

    expect(await roleLists(created.id)).toEqual({ managers: ['a'], billingManagers: [] });
  });

  it('refuses a role for a user with no roster row', async () => {
    const created = await Organization.create({ name: 'Org', userId: 'owner', users: [member('a')] });

    expect(await organizationRepository.setMemberRole(created.id, 'outsider', 'manager')).toBe(false);
    expect(await organizationRepository.setMemberRole(created.id, 'outsider', 'billingManager')).toBe(false);

    expect(await roleLists(created.id)).toEqual({ managers: [], billingManagers: [] });
  });

  it('refuses a role for a user whose roster row confers no membership', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [{ userId: 'a', permissions: [] }],
    });

    expect(await organizationRepository.setMemberRole(created.id, 'a', 'manager')).toBe(false);
  });

  it('keeps both appointments when two are made back to back from the same stale read', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('a'), member('b')],
    });

    await Promise.all([
      organizationRepository.setMemberRole(created.id, 'a', 'manager'),
      organizationRepository.setMemberRole(created.id, 'b', 'billingManager'),
    ]);

    expect(await roleLists(created.id)).toEqual({ managers: ['a'], billingManagers: ['b'] });
  });

  it('succeeds on an org whose role lists are stored as null', async () => {
    const created = await Organization.create({ name: 'Org', userId: 'owner', users: [member('a')] });
    await Organization.collection.updateOne(
      { _id: created._id },
      { $set: { adminUserIds: null, billingManagerUserIds: null } }
    );

    expect(await organizationRepository.setMemberRole(created.id, 'a', 'billingManager')).toBe(true);

    const raw = await Organization.collection.findOne({ _id: created._id });
    expect(raw!.adminUserIds).toEqual([]);
    expect(raw!.billingManagerUserIds).toEqual(['a']);
  });
});
