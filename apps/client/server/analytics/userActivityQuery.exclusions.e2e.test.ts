import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { buildUserActivityPipeline } from './userActivityQuery';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * The grid's two "Exclude" checkboxes against real data: the producer writes '' (not a label
 * such as 'Unknown') for a user without an org, and staff/test accounts are identified by user
 * flags or a staff email domain on the joined user.
 */
let mongoServer: MongoMemoryServer;
let counterLogs: mongoose.Collection;

const CUSTOMER = new mongoose.Types.ObjectId();
const NO_ORG_CUSTOMER = new mongoose.Types.ObjectId();
const LEGACY_NO_ORG_CUSTOMER = new mongoose.Types.ObjectId();
const ADMIN = new mongoose.Types.ObjectId();
const SYSTEM_ACCOUNT = new mongoose.Types.ObjectId();
const SYNTHETIC = new mongoose.Types.ObjectId();
const STAFF_DOMAIN = new mongoose.Types.ObjectId();
const DELETED_USER = new mongoose.Types.ObjectId();

const RANGE = { startDate: '2026-07-21', endDate: '2026-07-28', skip: 0, limit: 50 };
const STAFF_DOMAINS = ['staff.example.com'];

const log = (userId: mongoose.Types.ObjectId, userOrganization?: string) => ({
  userId: userId.toString(),
  userName: 'u',
  userLevel: '1',
  ...(userOrganization === undefined ? {} : { userOrganization }),
  counterName: 'Login',
  counterValue: 1,
  datetime: new Date('2026-07-24T10:00:00.000Z'),
  metadata: {},
});

const userIdsFor = async (params: Partial<Parameters<typeof buildUserActivityPipeline>[0]>) => {
  const { pipeline, facetStages } = buildUserActivityPipeline({ ...RANGE, staffDomains: STAFF_DOMAINS, ...params });
  const [facet] = await counterLogs.aggregate([...pipeline, { $facet: facetStages }]).toArray();
  return (facet.rows as Array<{ userId: string }>).map(row => row.userId).sort();
};

const ids = (...users: mongoose.Types.ObjectId[]) => users.map(user => user.toString()).sort();

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  const db = mongoose.connection.db!;
  counterLogs = db.collection('counterlogs');

  await db.collection('users').insertMany([
    { _id: CUSTOMER, email: 'customer@example.com' },
    { _id: NO_ORG_CUSTOMER, email: 'solo@example.com' },
    { _id: LEGACY_NO_ORG_CUSTOMER, email: 'legacy@example.com' },
    { _id: ADMIN, email: 'admin@example.com', isAdmin: true },
    { _id: SYSTEM_ACCOUNT, email: 'system@example.com', isSystem: true },
    { _id: SYNTHETIC, email: 'probe@example.com', isSynthetic: true },
    { _id: STAFF_DOMAIN, email: 'teammate@staff.example.com' },
  ]);

  await counterLogs.insertMany([
    log(CUSTOMER, 'Acme'),
    log(NO_ORG_CUSTOMER, ''),
    log(LEGACY_NO_ORG_CUSTOMER),
    log(ADMIN, 'Acme'),
    log(SYSTEM_ACCOUNT, 'Acme'),
    log(SYNTHETIC, 'Acme'),
    log(STAFF_DOMAIN, 'Acme'),
    log(DELETED_USER, 'Acme'),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('user activity exclusions against MongoDB', () => {
  it('excludes users without an org, whether the field is empty or missing', async () => {
    const userIds = await userIdsFor({ excludeNoOrg: true });

    expect(userIds).toEqual(ids(CUSTOMER, ADMIN, SYSTEM_ACCOUNT, SYNTHETIC, STAFF_DOMAIN, DELETED_USER));
  });

  it('excludes admin, system, synthetic and staff-domain accounts', async () => {
    const userIds = await userIdsFor({ excludeStaff: true });

    // A row whose user no longer exists has nothing marking it internal, so it stays.
    expect(userIds).toEqual(ids(CUSTOMER, NO_ORG_CUSTOMER, LEGACY_NO_ORG_CUSTOMER, DELETED_USER));
  });

  it('still excludes flagged accounts when no staff domains are configured', async () => {
    const userIds = await userIdsFor({ excludeStaff: true, staffDomains: [] });

    expect(userIds).toEqual(ids(CUSTOMER, NO_ORG_CUSTOMER, LEGACY_NO_ORG_CUSTOMER, STAFF_DOMAIN, DELETED_USER));
  });

  it('applies both exclusions together', async () => {
    const userIds = await userIdsFor({ excludeNoOrg: true, excludeStaff: true });

    expect(userIds).toEqual(ids(CUSTOMER, DELETED_USER));
  });

  it('excludes nothing when both are off', async () => {
    const userIds = await userIdsFor({});

    expect(userIds).toHaveLength(8);
  });

  it('keeps the internal-account flags out of the returned rows', async () => {
    const { pipeline, facetStages } = buildUserActivityPipeline({ ...RANGE, excludeStaff: true });
    const [facet] = await counterLogs.aggregate([...pipeline, { $facet: facetStages }]).toArray();

    for (const row of facet.rows) {
      expect(row).not.toHaveProperty('user');
      expect(row).not.toHaveProperty('isAdmin');
    }
  });
});
