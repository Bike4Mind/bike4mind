import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { OrgDomainClaim } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../database/src/__test__/createMongoServer';
import migration from './20261117212931_drop-legacy-domain-claim-org-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
const legacyName = 'organizationId_1_domain_1';

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await OrgDomainClaim.collection.drop().catch(error => {
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 26) throw error;
  });
});

const names = async () => (await OrgDomainClaim.collection.indexes()).map(index => index.name);
const spaceClaim = (spaceId: string) => ({
  spaceId,
  domain: 'acme.com',
  status: 'pending',
  verificationToken: 'token',
});

it('drops the legacy index, keeps both owner indexes, and frees Spaces to share a domain', async () => {
  await OrgDomainClaim.collection.createIndex({ organizationId: 1, domain: 1 }, { unique: true });
  await OrgDomainClaim.collection.insertOne(spaceClaim('a'.repeat(24)));
  await expect(OrgDomainClaim.collection.insertOne(spaceClaim('b'.repeat(24)))).rejects.toMatchObject({ code: 11000 });
  await OrgDomainClaim.collection.deleteMany({});

  await migration.up();

  expect(await names()).not.toContain(legacyName);
  expect(await names()).toEqual(
    expect.arrayContaining(['org_domain_claim_org_domain', 'org_domain_claim_space_domain'])
  );
  await OrgDomainClaim.collection.insertOne(spaceClaim('a'.repeat(24)));
  await OrgDomainClaim.collection.insertOne(spaceClaim('b'.repeat(24)));
  await expect(OrgDomainClaim.collection.insertOne(spaceClaim('a'.repeat(24)))).rejects.toMatchObject({ code: 11000 });
});

it('is a no-op when the legacy index is absent', async () => {
  await expect(migration.up()).resolves.toBeUndefined();
  expect(await names()).toEqual(
    expect.arrayContaining(['org_domain_claim_org_domain', 'org_domain_claim_space_domain'])
  );
});

it('is idempotent', async () => {
  await OrgDomainClaim.collection.createIndex({ organizationId: 1, domain: 1 }, { unique: true });
  await migration.up();
  await expect(migration.up()).resolves.toBeUndefined();
  expect(await names()).not.toContain(legacyName);
});

it('refuses a same-named index with a different shape and leaves it in place', async () => {
  await OrgDomainClaim.collection.createIndex(
    { organizationId: 1, domain: 1 },
    { name: legacyName, unique: true, partialFilterExpression: { organizationId: { $exists: true } } }
  );
  const drop = vi.spyOn(OrgDomainClaim.collection, 'dropIndex');
  await expect(migration.up()).rejects.toThrow('unrecognized legacy index');
  expect(drop).not.toHaveBeenCalled();
  expect(await names()).toContain(legacyName);
});

it.each([
  ['a different key order', { organizationId: 1, domain: -1 }, { unique: true }],
  ['a non-unique index', { organizationId: 1, domain: 1 }, {}],
  ['a sparse index', { organizationId: 1, domain: 1 }, { unique: true, sparse: true }],
])('refuses a same-named index that is %s and leaves it in place', async (_label, key, options) => {
  await OrgDomainClaim.collection.createIndex(key, { name: legacyName, ...options });
  const drop = vi.spyOn(OrgDomainClaim.collection, 'dropIndex');
  await expect(migration.up()).rejects.toThrow('unrecognized legacy index');
  expect(drop).not.toHaveBeenCalled();
  expect(await names()).toContain(legacyName);
});

it('tolerates only an index-not-found race', async () => {
  await OrgDomainClaim.collection.createIndex({ organizationId: 1, domain: 1 }, { unique: true });
  const drop = OrgDomainClaim.collection.dropIndex.bind(OrgDomainClaim.collection);
  vi.spyOn(OrgDomainClaim.collection, 'dropIndex').mockImplementationOnce(async name => {
    await drop(name);
    throw new mongoose.mongo.MongoServerError({ message: 'already dropped concurrently', code: 27 });
  });
  await expect(migration.up()).resolves.toBeUndefined();
  expect(await names()).not.toContain(legacyName);
});

it('propagates unexpected drop failures', async () => {
  await OrgDomainClaim.collection.createIndex({ organizationId: 1, domain: 1 }, { unique: true });
  const failure = new mongoose.mongo.MongoServerError({ message: 'permission denied', code: 13 });
  vi.spyOn(OrgDomainClaim.collection, 'dropIndex').mockRejectedValueOnce(failure);
  await expect(migration.up()).rejects.toBe(failure);
});
