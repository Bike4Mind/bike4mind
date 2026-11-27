import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { auditOrganizationStripeCustomers } from './auditOrganizationStripeCustomers';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;
const organizations = () => mongoose.connection.collection('organizations');

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await organizations().deleteMany({});
});

describe('auditOrganizationStripeCustomers', () => {
  it('reports shared customers including deleted organizations without changing data', async () => {
    await organizations().insertMany([
      { stripeCustomerId: 'cus_shared', deletedAt: null },
      { stripeCustomerId: 'cus_shared', deletedAt: new Date('2026-01-01') },
      { stripeCustomerId: 'cus_live' },
      { stripeCustomerId: 'cus_live' },
      { stripeCustomerId: 'cus_unique' },
      {},
      { stripeCustomerId: null },
      { stripeCustomerId: null },
      { stripeCustomerId: '' },
      { stripeCustomerId: '' },
      { stripeCustomerId: ['cus_shared'] },
      { stripeCustomerId: 123 },
      { stripeCustomerId: 123 },
    ]);
    const before = await organizations().find().sort({ _id: 1 }).toArray();

    const result = await auditOrganizationStripeCustomers();

    expect(result).toEqual([
      {
        stripeCustomerId: 'cus_live',
        count: 2,
        organizations: before
          .filter(org => org.stripeCustomerId === 'cus_live')
          .map(org => ({ organizationId: String(org._id), deleted: false })),
      },
      {
        stripeCustomerId: 'cus_shared',
        count: 2,
        organizations: before
          .filter(org => org.stripeCustomerId === 'cus_shared')
          .map(org => ({ organizationId: String(org._id), deleted: org.deletedAt != null })),
      },
    ]);
    expect(await organizations().find().sort({ _id: 1 }).toArray()).toEqual(before);
    expect(await auditOrganizationStripeCustomers()).toEqual(result);
  });

  it('returns an empty report when no organizations share a customer', async () => {
    expect(await auditOrganizationStripeCustomers()).toEqual([]);
    await organizations().insertMany([{ stripeCustomerId: 'cus_one' }, { stripeCustomerId: 'cus_two' }]);
    expect(await auditOrganizationStripeCustomers()).toEqual([]);
  });
});
