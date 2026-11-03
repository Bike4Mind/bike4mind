// @vitest-environment node
/**
 * A skills:read key is not org-bound, so departure leaves it ACTIVE; the feed and zip routes cut the
 * member off by re-checking membership (memberOrgIdsFor) per request. `call` re-reads `req.user` from
 * the DB as apiKeyAuth does. Services run without withTransaction: standalone mongod rejects writes
 * inside a session.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyScope, ApiKeyStatus, Permission } from '@bike4mind/common';
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
    return { get: compose, post: compose, delete: compose };
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

process.env.APP_URL = 'https://app.example.test/';

const { default: feedHandler } = await import('@pages/api/v1/skills/market/claude-marketplace.json');
const { default: zipHandler } = await import('@pages/api/v1/skills/market/[id]/claude-plugin.zip');
const { default: searchHandler } = await import('@pages/api/v1/skills/market/listings/index');
const { default: detailHandler } = await import('@pages/api/v1/skills/market/listings/[id]/index');

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

type MarketplaceHandler = typeof feedHandler | typeof zipHandler | typeof searchHandler | typeof detailHandler;
type MarketplaceRequest = Parameters<typeof feedHandler>[0] & Parameters<typeof zipHandler>[0];
type MarketplaceResponse = Parameters<typeof feedHandler>[1];

const newUser = (name: string) =>
  User.create({ name, username: `${name}-${new mongoose.Types.ObjectId()}`, password: null, hasUsablePassword: false });

async function call(handler: MarketplaceHandler, userId: string, query: Record<string, string>) {
  const { req, res } = createMocks<MarketplaceRequest, MarketplaceResponse>({ method: 'GET', query });
  Object.assign(req, { user: await User.findById(userId), logger });
  try {
    await handler(req as never, res);
  } catch (err) {
    const { statusCode } = err as { statusCode?: number };
    if (statusCode === undefined) throw err;
    return { statusCode, res };
  }
  return { statusCode: res._getStatusCode(), res };
}

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
  return { orgId, listingId: listing.id as string, skillName: `${name}-skill` };
}

async function seed() {
  // Detail's similar-listings fallback runs a $text query, and afterEach drops the indexes.
  await SkillListing.ensureIndexes();
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

type Owner = Awaited<ReturnType<typeof seed>>['owner'];

const keyStatus = async (userId: string) => (await UserApiKey.findOne({ userId }))?.status;

const feedStatus = async (userId: string, orgId: string) => (await call(feedHandler, userId, { orgId })).statusCode;
const zipStatus = async (userId: string, listingId: string) =>
  (await call(zipHandler, userId, { id: listingId })).statusCode;

const searchedNames = async (userId: string) => {
  const { statusCode, res } = await call(searchHandler, userId, {});
  expect(statusCode).toBe(200);
  return (res._getJSONData() as { data: { name: string }[] }).data.map(listing => listing.name);
};
const detailStatus = async (userId: string, listingId: string) =>
  (await call(detailHandler, userId, { id: listingId })).statusCode;

async function expectServingOrg(userId: string, org: Awaited<ReturnType<typeof seedOrg>>) {
  const feed = await call(feedHandler, userId, { orgId: org.orgId });
  expect(feed.statusCode).toBe(200);
  const marketplace: unknown = feed.res._getJSONData();
  expect(marketplace).toMatchObject({ plugins: [{ name: org.skillName, version: '1' }] });

  const zip = await call(zipHandler, userId, { id: org.listingId });
  expect(zip.statusCode).toBe(200);
  const archive: unknown = zip.res._getData();
  if (!Buffer.isBuffer(archive)) throw new TypeError('Expected a plugin ZIP buffer');
  // The builder stores uncompressed entries, so both the path and SKILL.md text are readable.
  const archiveText = archive.toString('utf8');
  expect(archiveText).toContain(`skills/${org.skillName}/SKILL.md`);
  expect(archiveText).toContain(`name: ${org.skillName}`);
  expect(archiveText).toContain('Check the diff.');

  expect(await searchedNames(userId)).toContain(org.skillName);
  expect(await detailStatus(userId, org.listingId)).toBe(200);
}

describe('skills:read key after its owner exits an org', () => {
  it.each([
    [
      'is removed by an admin',
      (owner: Owner, memberId: string, orgId: string) =>
        organizationService.revokeAccess(owner, { id: orgId, userId: memberId }, departureAdapters),
    ],
    [
      'leaves',
      async (_owner: unknown, memberId: string, orgId: string) =>
        organizationService.leave((await User.findById(memberId))!, { id: orgId }, departureAdapters),
    ],
    [
      'loses the org to deletion',
      (owner: Owner, _memberId: string, orgId: string) =>
        organizationService.deleteOrganization(owner, { id: orgId }, departureAdapters),
    ],
  ])("stays active but loses the org's feed and zip when the member %s", async (_label, depart) => {
    const { owner, memberId, a } = await seed();
    await expectServingOrg(memberId, a);

    await depart(owner, memberId, a.orgId);

    expect(await keyStatus(memberId)).toBe(ApiKeyStatus.ACTIVE);
    expect(await feedStatus(memberId, a.orgId)).toBe(403);
    expect(await zipStatus(memberId, a.listingId)).toBe(404);
    expect(await searchedNames(memberId)).not.toContain(a.skillName);
    // A listing the viewer cannot see is a 404, exactly what a user who was never a member gets.
    expect(await detailStatus(memberId, a.listingId)).toBe(404);
    expect(await detailStatus((await newUser('outsider')).id, a.listingId)).toBe(404);
  });

  it("keeps serving the user's other org", async () => {
    const { owner, memberId, a } = await seed();
    const b = await seedOrg(owner, memberId, 'globex');

    await organizationService.revokeAccess(owner, { id: a.orgId, userId: memberId }, departureAdapters);

    expect(await keyStatus(memberId)).toBe(ApiKeyStatus.ACTIVE);
    expect(await feedStatus(memberId, a.orgId)).toBe(403);
    expect(await zipStatus(memberId, a.listingId)).toBe(404);
    expect(await searchedNames(memberId)).not.toContain(a.skillName);
    expect(await detailStatus(memberId, a.listingId)).toBe(404);
    await expectServingOrg(memberId, b);
  });
});
