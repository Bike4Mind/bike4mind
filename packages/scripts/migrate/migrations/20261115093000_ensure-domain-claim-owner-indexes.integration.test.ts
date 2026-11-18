import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { OrgDomainClaim } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../database/src/__test__/createMongoServer';
import migration from './20261115093000_ensure-domain-claim-owner-indexes';

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
  await OrgDomainClaim.collection.drop().catch(error => {
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 26) throw error;
  });
  await OrgDomainClaim.collection.createIndex({ organizationId: 1, domain: 1 }, { unique: true });
});

const claim = (owner: Record<string, string>, domain: string) => ({
  ...owner,
  domain,
  status: 'pending',
  verificationToken: 'token',
});

it('adds both owner indexes beside the legacy index and is repeatable', async () => {
  await migration.up();
  await migration.up();
  const indexes = await OrgDomainClaim.collection.indexes();
  expect(indexes.map(index => index.name)).toEqual(
    expect.arrayContaining([legacyName, 'org_domain_claim_org_domain', 'org_domain_claim_space_domain'])
  );
  expect(indexes.find(index => index.name === 'org_domain_claim_org_domain')).toMatchObject({
    key: { domain: 1, organizationId: 1 },
    unique: true,
    partialFilterExpression: { organizationId: { $exists: true } },
  });
  expect(indexes.find(index => index.name === 'org_domain_claim_space_domain')).toMatchObject({
    key: { spaceId: 1, domain: 1 },
    unique: true,
    partialFilterExpression: { spaceId: { $exists: true } },
  });
});

it('keeps one claim per owner and domain, and lets different owners share a domain', async () => {
  await migration.up();
  const claims = OrgDomainClaim.collection;
  await claims.insertOne(claim({ organizationId: 'a'.repeat(24) }, 'acme.com'));
  await claims.insertOne(claim({ organizationId: 'b'.repeat(24) }, 'acme.com'));
  await expect(claims.insertOne(claim({ organizationId: 'a'.repeat(24) }, 'acme.com'))).rejects.toMatchObject({
    code: 11000,
  });
  await claims.insertOne(claim({ spaceId: 'c'.repeat(24) }, 'other.com'));
  await expect(claims.insertOne(claim({ spaceId: 'c'.repeat(24) }, 'other.com'))).rejects.toMatchObject({
    code: 11000,
  });
});
