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

describe('OrganizationModel.setAccountSegment', () => {
  it('sets the segment and unsets the field for null', async () => {
    const org = await Organization.create({ name: 'Org', userId: 'owner' });

    await organizationRepository.setAccountSegment(org.id, 'internal');
    expect((await Organization.findById(org.id).lean())?.accountSegment).toBe('internal');

    await organizationRepository.setAccountSegment(org.id, null);
    const after = await Organization.findById(org.id).lean();
    expect(after).not.toBeNull();
    expect(after).not.toHaveProperty('accountSegment');
  });
});
