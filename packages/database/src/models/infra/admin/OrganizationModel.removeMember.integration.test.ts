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
const details = (id: string) => ({ id, email: `${id}@example.com`, name: id, usedCredits: 0 });

describe('OrganizationModel.removeMember', () => {
  it('drops the member from every list and leaves other members alone', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('leaver'), member('stayer')],
      userDetails: [details('leaver'), details('stayer')],
      adminUserIds: ['leaver', 'stayer'],
      billingManagerUserIds: ['leaver', 'stayer'],
    });

    await organizationRepository.removeMember(created.id, 'leaver');

    const after = await Organization.findById(created.id).lean();
    expect(after!.users.map(u => u.userId)).toEqual(['stayer']);
    expect(after!.userDetails!.map(d => d.id)).toEqual(['stayer']);
    expect(after!.adminUserIds).toEqual(['stayer']);
    expect(after!.billingManagerUserIds).toEqual(['stayer']);
  });

  it('succeeds on an org whose lists are stored as null', async () => {
    const created = await Organization.create({ name: 'Org', userId: 'owner', users: [member('leaver')] });
    // Raw write: the schema defaults would otherwise replace null with [].
    await Organization.collection.updateOne(
      { _id: created._id },
      { $set: { userDetails: null, adminUserIds: null, billingManagerUserIds: null } }
    );

    await organizationRepository.removeMember(created.id, 'leaver');

    const raw = await Organization.collection.findOne({ _id: created._id });
    expect(raw!.users).toEqual([]);
    expect(raw!.userDetails).toEqual([]);
    expect(raw!.adminUserIds).toEqual([]);
    expect(raw!.billingManagerUserIds).toEqual([]);
  });

  it('records the user in removedUserIds only when blocking, without duplicates', async () => {
    const created = await Organization.create({
      name: 'Org',
      userId: 'owner',
      users: [member('left'), member('removed')],
    });
    // Raw write: an org saved before the field existed has no removedUserIds at all.
    await Organization.collection.updateOne({ _id: created._id }, { $unset: { removedUserIds: '' } });

    await organizationRepository.removeMember(created.id, 'left');
    await organizationRepository.removeMember(created.id, 'removed', { block: true });
    await organizationRepository.removeMember(created.id, 'removed', { block: true });

    const after = await Organization.findById(created.id).lean();
    expect(after!.users).toEqual([]);
    expect(after!.removedUserIds).toEqual(['removed']);
  });

  it('clearRemovedMember lifts only that user', async () => {
    const created = await Organization.create({ name: 'Org', userId: 'owner', removedUserIds: ['a', 'b'] });

    await organizationRepository.clearRemovedMember(created.id, 'a');

    const after = await Organization.findById(created.id).lean();
    expect(after!.removedUserIds).toEqual(['b']);
  });
});
