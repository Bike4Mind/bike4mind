import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import { Logger } from '@bike4mind/observability';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Organization, OrgDomainClaim, orgDomainClaimRepository, User } from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
type OrgDeleteHandler = (request: Request, response: Response) => Promise<void>;
const organizationRoute = vi.hoisted(() => ({ delete: null as OrgDeleteHandler | null }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    get: () => chain,
    put: () => chain,
    delete: (handler: OrgDeleteHandler) => {
      organizationRoute.delete = handler;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
import '@pages/api/organizations/[id]/index';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: MongoMemoryReplSet;
beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await OrgDomainClaim.createIndexes();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await mongoose.disconnect();
  await database?.stop();
});

it('rolls back domain claim deletion with the actual HTTP delete, then permits retry and reclaim', async () => {
  const user = await User.create({ name: 'Owner', username: 'domain-owner', password: null, hasUsablePassword: false });
  const userId = String(user.id);
  const org = await Organization.create({ name: 'Claim rollback', userId, personal: false });
  const organizationId = String(org.id);
  const domain = `${organizationId}.example.test`;
  await orgDomainClaimRepository.create({
    organizationId,
    domain,
    status: 'verified',
    verificationToken: 'local-test-verifier',
    verifiedAt: new Date(),
    policy: 'off',
    createdBy: userId,
  });
  const logger = new Logger({ metadata: { service: 'domainDeletionTest' } });
  const remove = async () => {
    const { req, res } = createMocks<Request, Response>({ method: 'DELETE', query: { id: organizationId } });
    Object.assign(req, { user, logger });
    if (!organizationRoute.delete) throw new Error('Missing organization delete handler');
    await organizationRoute.delete(req, res);
    expect(res._getStatusCode()).toBe(200);
  };
  const deleteClaims = orgDomainClaimRepository.deleteByOrganization.bind(orgDomainClaimRepository);
  const failure = vi.spyOn(orgDomainClaimRepository, 'deleteByOrganization').mockImplementationOnce(async id => {
    await deleteClaims(id);
    throw new Error('claim cleanup interrupted');
  });
  try {
    await expect(remove()).rejects.toThrow('claim cleanup interrupted');
    expect(await Organization.findById(org.id)).not.toBeNull();
    expect(await OrgDomainClaim.countDocuments({ organizationId })).toBe(1);
    expect(await User.exists({ _id: userId })).not.toBeNull();
  } finally {
    failure.mockRestore();
  }
  await remove();
  expect(await Organization.findById(org.id)).toBeNull();
  expect(await OrgDomainClaim.countDocuments({ organizationId })).toBe(0);
  await expect(
    orgDomainClaimRepository.create({
      organizationId: new mongoose.Types.ObjectId().toString(),
      domain,
      status: 'verified',
      verificationToken: 'new-local-test-verifier',
      verifiedAt: new Date(),
      policy: 'off',
      createdBy: null,
    })
  ).resolves.toBeTruthy();
});
