import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { mongoose, Organization } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { defaultPaidScopeDeps } from './paidScopes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await Organization.collection.deleteMany({});
});

describe('defaultPaidScopeDeps.findPlanHolderOrganizations against Mongo', () => {
  it('matches owner, manager, billing manager and seat arms and projects only plan-holder fields', async () => {
    const [ownerOrg, managerOrg, billingOrg, seatOrg, noSeatOrg, unrelatedOrg] = Array.from(
      { length: 6 },
      () => new mongoose.Types.ObjectId()
    );
    await Organization.collection.insertMany([
      { _id: ownerOrg, name: 'Owned', userId: 'u1', adminUserIds: [], users: [] },
      { _id: managerOrg, name: 'Managed', userId: 'other', adminUserIds: ['u1'], users: [] },
      { _id: billingOrg, name: 'Billing', userId: 'other', billingManagerUserIds: ['u1'], users: [] },
      { _id: seatOrg, name: 'Seat', userId: 'other', users: [{ userId: 'u1', permissions: ['read'] }] },
      { _id: noSeatOrg, name: 'No seat', userId: 'other', users: [{ userId: 'u1', permissions: [] }] },
      { _id: unrelatedOrg, name: 'Unrelated', userId: 'other', users: [{ userId: 'u2', permissions: ['write'] }] },
    ]);

    const found = await defaultPaidScopeDeps().findPlanHolderOrganizations(['u1']);

    expect(found.map(organization => organization.id).sort()).toEqual(
      [ownerOrg, managerOrg, billingOrg, seatOrg].map(String).sort()
    );
    expect(found.find(organization => organization.id === String(billingOrg))).toMatchObject({
      billingManagerUserIds: ['u1'],
    });
    const seat = found.find(organization => organization.id === String(seatOrg));
    expect(seat).toMatchObject({ userId: 'other', users: [{ userId: 'u1', permissions: ['read'] }] });
    expect(seat).not.toHaveProperty('name');
  });

  it('returns nothing for an empty user list without querying', async () => {
    await Organization.collection.insertOne({ userId: 'u1' });
    await expect(defaultPaidScopeDeps().findPlanHolderOrganizations([])).resolves.toEqual([]);
  });
});
