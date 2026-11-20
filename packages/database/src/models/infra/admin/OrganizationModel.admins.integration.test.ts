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

describe('OrganizationModel.addAdmin / removeAdmin', () => {
  it('appends a member without touching the sitting managers', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('a'), member('b')],
      adminUserIds: ['a'],
    });

    expect(await organizationRepository.addAdmin(created.id, 'b')).toBe(true);

    const after = await Organization.findById(created.id).lean();
    expect(after!.adminUserIds).toEqual(['a', 'b']);
  });

  it('is idempotent for a sitting manager', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('a')],
      adminUserIds: ['a'],
    });

    expect(await organizationRepository.addAdmin(created.id, 'a')).toBe(true);

    const after = await Organization.findById(created.id).lean();
    expect(after!.adminUserIds).toEqual(['a']);
  });

  it('refuses a user with no roster row', async () => {
    const created = await Organization.create({ name: 'Org', userId: 'owner', users: [member('a')] });

    expect(await organizationRepository.addAdmin(created.id, 'outsider')).toBe(false);

    const after = await Organization.findById(created.id).lean();
    expect(after!.adminUserIds).toEqual([]);
  });

  it('refuses a user whose roster row confers no membership', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [{ userId: 'a', permissions: [] }],
    });

    expect(await organizationRepository.addAdmin(created.id, 'a')).toBe(false);
  });

  it('keeps both appointments when two are made back to back from the same stale read', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('a'), member('b')],
    });

    await Promise.all([
      organizationRepository.addAdmin(created.id, 'a'),
      organizationRepository.addAdmin(created.id, 'b'),
    ]);

    const after = await Organization.findById(created.id).lean();
    expect([...after!.adminUserIds].sort()).toEqual(['a', 'b']);
  });

  it('removes only the named manager', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('a'), member('b')],
      adminUserIds: ['a', 'b'],
    });

    await organizationRepository.removeAdmin(created.id, 'a');

    const after = await Organization.findById(created.id).lean();
    expect(after!.adminUserIds).toEqual(['b']);
    expect(after!.users.map(u => u.userId)).toEqual(['a', 'b']);
  });

  it('succeeds on an org whose adminUserIds is stored as null', async () => {
    const created = await Organization.create({ name: 'Org', userId: 'owner', users: [member('a')] });
    await Organization.collection.updateOne({ _id: created._id }, { $set: { adminUserIds: null } });

    expect(await organizationRepository.addAdmin(created.id, 'a')).toBe(true);
    expect((await Organization.collection.findOne({ _id: created._id }))!.adminUserIds).toEqual(['a']);

    await Organization.collection.updateOne({ _id: created._id }, { $set: { adminUserIds: null } });
    await organizationRepository.removeAdmin(created.id, 'a');
    expect((await Organization.collection.findOne({ _id: created._id }))!.adminUserIds).toEqual([]);
  });
});
