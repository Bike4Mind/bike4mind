import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
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

describe('OrganizationModel.incrementCurrentStorage', () => {
  // Raw seed/read: currentStorageSize is on IOrganization but not in the schema, so strict mode
  // would drop it from a model create.
  const storage = async (id: mongoose.Types.ObjectId) =>
    (await Organization.collection.findOne({ _id: id }))!.currentStorageSize;

  it('adds atomically and floors at zero', async () => {
    const created = await Organization.create({ name: 'Org', userId: 'owner', users: [] });
    await Organization.collection.updateOne({ _id: created._id }, { $set: { currentStorageSize: 10 } });

    await organizationRepository.incrementCurrentStorage(created.id, 5);
    expect(await storage(created._id)).toBe(15);

    await organizationRepository.incrementCurrentStorage(created.id, -100);
    expect(await storage(created._id)).toBe(0);
  });
});
