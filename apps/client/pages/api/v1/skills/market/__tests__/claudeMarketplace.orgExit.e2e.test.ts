// @vitest-environment node
/**
 * A skills:read key is per user, not per org, so leaving an org does not (and must not) revoke it:
 * it still serves the user's other orgs. What cuts the departed member off is that the feed and
 * zip routes re-check membership (memberOrgIdsFor) on every request. This suite proves that against
 * a real mongod and the real departure services, so a cached or removed membership check fails it.
 *
 * `baseApi` is stubbed as in claudeMarketplace.test.ts, so key authentication is not driven here;
 * `call` re-reads `req.user` from the DB per request, as apiKeyAuth does. The services run without
 * withTransaction because a standalone mongod rejects writes inside a session.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyScope, ApiKeyStatus, Permission } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';
import {
  Organization,
  SkillListing,
  SkillListingVersion,
  User,
  UserApiKey,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
} from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { userRepository } from '@bike4mind/database/auth';
import { groupRepository } from '@bike4mind/database/social';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { organizationService } from '@bike4mind/services';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) =>
    res.status(405).end(),
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    return { get: compose };
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

process.env.APP_URL = 'https://app.example.test/';

const { default: feedHandler } = await import('@pages/api/v1/skills/market/claude-marketplace.json');
const { default: zipHandler } = await import('@pages/api/v1/skills/market/[id]/claude-plugin.zip');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const departureAdapters = {
  db: {
    organizations: organizationRepository,
    users: userRepository,
    groups: groupRepository,
    dataLakes: dataLakeRepository,
    dataLakeAccessGrants: dataLakeAccessGrantRepository,
    ...lakeConfigAuditDb,
  },
  logger,
};

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

type MarketplaceRequest = Parameters<typeof feedHandler>[0] & Parameters<typeof zipHandler>[0];
type MarketplaceResponse = Parameters<typeof feedHandler>[1];

const newUser = (name: string) =>
  User.create({ name, username: `${name}-${new mongoose.Types.ObjectId()}`, password: null, hasUsablePassword: false });

async function call(handler: typeof feedHandler | typeof zipHandler, userId: string, query: Record<string, string>) {
  const { req, res } = createMocks<MarketplaceRequest, MarketplaceResponse>({ method: 'GET', query });
  const key = await UserApiKey.findOne({ userId });
  Object.assign(req, {
    user: await User.findById(userId),
    apiKeyInfo: { id: key!.id, scopes: key!.scopes },
    logger,
  });
  try {
    await handler(req, res);
  } catch (err) {
    return (err as { statusCode?: number }).statusCode;
  }
  return res._getStatusCode();
}

/** An org owned by `owner` with `memberId` as a read/write member, holding one approved Organization listing. */
async function seedOrg(owner: { id: string }, memberId: string, name: string) {
  const org = await Organization.create({
    name,
    userId: owner.id,
    users: [{ userId: memberId, permissions: [Permission.read, Permission.update] }],
  });
  const orgId = String(org._id);
  const listing = await SkillListing.create({
    sourceSkillId: new mongoose.Types.ObjectId().toString(),
    authorUserId: owner.id,
    visibility: 'organization',
    organizationId: orgId,
    status: 'approved',
    name: `${name}-skill`,
    description: 'Review a PR',
    claudePluginName: `${name}-skill`,
    currentVersion: 1,
  });
  const version = await SkillListingVersion.create({
    listingId: listing.id,
    version: 1,
    snapshot: { name: `${name}-skill`, description: 'Review a PR', body: 'Check the diff.' },
    contentHash: 'h',
    scanStatus: 'passed',
    reviewStatus: 'approved',
  });
  await SkillListing.updateOne({ _id: listing._id }, { $set: { currentApprovedVersionId: version.id } });
  return { orgId, listingId: listing.id as string };
}

async function seed() {
  const owner = await newUser('owner');
  const member = await newUser('member');
  const a = await seedOrg(owner, member.id, 'acme');
  await UserApiKey.create({
    userId: member.id,
    name: 'Claude Code marketplace',
    keyPrefix: `b4m_${new mongoose.Types.ObjectId()}`,
    scopes: [ApiKeyScope.SKILLS_READ],
    status: ApiKeyStatus.ACTIVE,
    metadata: { createdFrom: 'dashboard' },
  });
  return { owner, memberId: member.id as string, a };
}

const keyStatus = async (userId: string) => (await UserApiKey.findOne({ userId }))?.status;

const feedStatus = (userId: string, orgId: string) => call(feedHandler, userId, { orgId });
const zipStatus = (userId: string, listingId: string) => call(zipHandler, userId, { id: listingId });

describe('skills:read key after its owner exits an org', () => {
  it.each([
    [
      'is removed by an admin',
      (owner: Awaited<ReturnType<typeof seed>>['owner'], memberId: string, orgId: string) =>
        organizationService.revokeAccess(owner, { id: orgId, userId: memberId }, departureAdapters),
    ],
    [
      'leaves',
      async (_owner: unknown, memberId: string, orgId: string) =>
        organizationService.leave((await User.findById(memberId))!, { id: orgId }, departureAdapters),
    ],
    [
      'loses the org to deletion',
      (owner: Awaited<ReturnType<typeof seed>>['owner'], _memberId: string, orgId: string) =>
        organizationService.deleteOrganization(owner, { id: orgId }, departureAdapters),
    ],
  ])("stays active but loses the org's feed and zip when the member %s", async (_label, depart) => {
    const { owner, memberId, a } = await seed();
    expect(await feedStatus(memberId, a.orgId)).toBe(200);
    expect(await zipStatus(memberId, a.listingId)).toBe(200);

    await depart(owner, memberId, a.orgId);

    expect(await keyStatus(memberId)).toBe(ApiKeyStatus.ACTIVE);
    expect(await feedStatus(memberId, a.orgId)).toBe(403);
    expect(await zipStatus(memberId, a.listingId)).toBe(404);
  });

  it("keeps serving the user's other org", async () => {
    const { owner, memberId, a } = await seed();
    const b = await seedOrg(owner, memberId, 'globex');

    await organizationService.revokeAccess(owner, { id: a.orgId, userId: memberId }, departureAdapters);

    expect(await keyStatus(memberId)).toBe(ApiKeyStatus.ACTIVE);
    expect(await feedStatus(memberId, a.orgId)).toBe(403);
    expect(await zipStatus(memberId, a.listingId)).toBe(404);
    expect(await feedStatus(memberId, b.orgId)).toBe(200);
    expect(await zipStatus(memberId, b.listingId)).toBe(200);
  });
});
