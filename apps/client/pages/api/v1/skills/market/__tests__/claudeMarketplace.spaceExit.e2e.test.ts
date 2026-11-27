// @vitest-environment node
/**
 * A skills:read key is not Space-bound, so leaving a Space leaves it ACTIVE; the feed, zip, search
 * and detail routes cut the member off by re-checking Space membership (audienceIdsFor) per request.
 * `call` re-reads `req.user` from the DB as apiKeyAuth does. Services run without withTransaction:
 * standalone mongod rejects writes inside a session.
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
  SkillBundle,
  SkillListing,
  SkillListingVersion,
  Space,
  User,
  UserApiKey,
  inviteRepository,
  orgDomainClaimRepository,
  spaceRepository,
} from '@bike4mind/database';
import { userRepository } from '@bike4mind/database/auth';
import { spaceService } from '@bike4mind/services';

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
const flag = vi.hoisted(() => ({ on: true }));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', async importOriginal => ({
  ...(await importOriginal<object>()),
  isFeatureEnabled: async () => flag.on,
}));

process.env.APP_URL = 'https://app.example.test/';

const { default: feedHandler } = await import('@pages/api/v1/skills/market/claude-marketplace.json');
const { default: zipHandler } = await import('@pages/api/v1/skills/market/[id]/claude-plugin.zip');
const { default: bundleZipHandler } = await import('@pages/api/v1/skills/market/bundles/[id]/claude-plugin.zip');
const { default: searchHandler } = await import('@pages/api/v1/skills/market/listings/index');
const { default: detailHandler } = await import('@pages/api/v1/skills/market/listings/[id]/index');
const { default: reviewQueueHandler } = await import('@pages/api/v1/skills/market/review-queue');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const exitAdapters = {
  db: { spaces: spaceRepository, invites: inviteRepository, users: userRepository },
};
const removeAdapters = {
  db: { spaces: spaceRepository, invites: inviteRepository, orgDomainClaims: orgDomainClaimRepository },
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
  flag.on = true;
  await mongoose.connection.dropDatabase();
});

type Handler =
  | typeof feedHandler
  | typeof zipHandler
  | typeof bundleZipHandler
  | typeof searchHandler
  | typeof detailHandler
  | typeof reviewQueueHandler;
type Req = Parameters<typeof feedHandler>[0] & Parameters<typeof zipHandler>[0];
type Res = Parameters<typeof feedHandler>[1];

const newUser = (name: string) =>
  User.create({ name, username: `${name}-${new mongoose.Types.ObjectId()}`, password: null, hasUsablePassword: false });

async function call(handler: Handler, userId: string, query: Record<string, string>) {
  const { req, res } = createMocks<Req, Res>({ method: 'GET', query });
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

const joined = { joinedVia: 'invite' as const, joinedAt: new Date() };

async function seedListing(
  owner: { visibility: 'space' | 'organization'; id: string },
  authorId: string,
  name: string
) {
  const listing = await SkillListing.create({
    sourceSkillId: new mongoose.Types.ObjectId().toString(),
    authorUserId: authorId,
    visibility: owner.visibility,
    ...(owner.visibility === 'space' ? { spaceId: owner.id } : { organizationId: owner.id }),
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
  return { listingId: listing.id as string, skillName: `${name}-skill` };
}

async function seedSpace(ownerId: string, memberId: string, name: string, role: 'admin' | 'member' = 'member') {
  const space = await Space.create({
    name,
    ownerUserId: ownerId,
    members: [{ userId: memberId, role, ...joined }],
  });
  const spaceId = String(space._id);
  const listing = await seedListing({ visibility: 'space', id: spaceId }, ownerId, name);
  const bundle = await SkillBundle.create({
    spaceId,
    name: `${name} pack`,
    description: 'd',
    pluginName: `${name}-pack`,
    listingIds: [listing.listingId],
    createdByUserId: ownerId,
  });
  return { spaceId, ...listing, bundleId: bundle.id as string };
}

async function seed() {
  // Detail's similar-listings fallback runs a $text query, and afterEach drops the indexes.
  await SkillListing.ensureIndexes();
  const owner = await newUser('owner');
  const member = await newUser('member');
  const a = await seedSpace(owner.id, member.id, 'acme');
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

type Seeded = Awaited<ReturnType<typeof seed>>;
type SpaceSeed = Seeded['a'];

const keyStatus = async (userId: string) => (await UserApiKey.findOne({ userId }))?.status;
const feedStatus = async (userId: string, spaceId: string) => (await call(feedHandler, userId, { spaceId })).statusCode;
const zipStatus = async (userId: string, listingId: string) =>
  (await call(zipHandler, userId, { id: listingId })).statusCode;
const bundleZipStatus = async (userId: string, bundleId: string) =>
  (await call(bundleZipHandler, userId, { id: bundleId })).statusCode;
const detailStatus = async (userId: string, listingId: string) =>
  (await call(detailHandler, userId, { id: listingId })).statusCode;
const searchedNames = async (userId: string) => {
  const { statusCode, res } = await call(searchHandler, userId, {});
  expect(statusCode).toBe(200);
  return (res._getJSONData() as { data: { name: string }[] }).data.map(listing => listing.name);
};

const asBuffer = (value: unknown) => {
  if (!Buffer.isBuffer(value)) throw new TypeError('Expected a plugin ZIP buffer');
  return value.toString('utf8');
};

async function expectServing(userId: string, space: SpaceSeed) {
  const feed = await call(feedHandler, userId, { spaceId: space.spaceId });
  expect(feed.statusCode).toBe(200);
  expect(feed.res._getJSONData()).toMatchObject({
    name: `b4m-space-${space.spaceId}`,
    plugins: [{ name: space.skillName, version: '1' }, { name: `${space.skillName.replace('-skill', '')}-pack` }],
  });

  const zip = await call(zipHandler, userId, { id: space.listingId });
  expect(zip.statusCode).toBe(200);
  expect(asBuffer(zip.res._getData())).toContain('Check the diff.');

  const bundle = await call(bundleZipHandler, userId, { id: space.bundleId });
  expect(bundle.statusCode).toBe(200);
  expect(asBuffer(bundle.res._getData())).toContain(`skills/${space.skillName}/SKILL.md`);

  expect(await searchedNames(userId)).toContain(space.skillName);
  expect(await detailStatus(userId, space.listingId)).toBe(200);
}

async function expectCutOff(userId: string, space: SpaceSeed) {
  expect(await keyStatus(userId)).toBe(ApiKeyStatus.ACTIVE);
  expect(await feedStatus(userId, space.spaceId)).toBe(403);
  expect(await zipStatus(userId, space.listingId)).toBe(404);
  expect(await bundleZipStatus(userId, space.bundleId)).toBe(404);
  expect(await searchedNames(userId)).not.toContain(space.skillName);
  // A listing the viewer cannot see is a 404, exactly what a user who was never a member gets.
  expect(await detailStatus(userId, space.listingId)).toBe(404);
  expect(await detailStatus((await newUser('outsider')).id, space.listingId)).toBe(404);
}

describe('skills:read key after its owner exits a Space', () => {
  it.each([
    [
      'is removed by an admin',
      (owner: { id: string }, memberId: string, spaceId: string) =>
        spaceService.removeMember(owner as never, { spaceId, userId: memberId }, exitAdapters),
    ],
    [
      'leaves',
      async (_owner: unknown, memberId: string, spaceId: string) =>
        spaceService.leave((await User.findById(memberId))!, { spaceId }, { db: { spaces: spaceRepository } }),
    ],
    [
      'loses the Space to deletion',
      (owner: { id: string }, _memberId: string, spaceId: string) =>
        spaceService.remove(owner as never, { spaceId }, removeAdapters),
    ],
  ])("stays active but loses the Space's feed, zips, search and detail when the member %s", async (_l, depart) => {
    const { owner, memberId, a } = await seed();
    await expectServing(memberId, a);

    await depart(owner, memberId, a.spaceId);

    await expectCutOff(memberId, a);
  });

  it("keeps serving the user's other Space and their org", async () => {
    const { owner, memberId, a } = await seed();
    const b = await seedSpace(owner.id, memberId, 'globex');
    const org = await Organization.create({
      name: 'initech',
      userId: owner.id,
      users: [{ userId: memberId, permissions: [Permission.read] }],
    });
    const orgListing = await seedListing({ visibility: 'organization', id: String(org._id) }, owner.id, 'initech');

    await spaceService.removeMember(owner as never, { spaceId: a.spaceId, userId: memberId }, exitAdapters);

    expect(await feedStatus(memberId, a.spaceId)).toBe(403);
    expect(await zipStatus(memberId, a.listingId)).toBe(404);
    await expectServing(memberId, b);
    expect(await searchedNames(memberId)).toEqual(expect.arrayContaining([b.skillName, orgListing.skillName]));
    expect(await zipStatus(memberId, orgListing.listingId)).toBe(200);
  });

  it('serves nothing while EnableSpaces is off', async () => {
    const { memberId, a } = await seed();
    flag.on = false;

    expect(await feedStatus(memberId, a.spaceId)).toBe(403);
    expect(await zipStatus(memberId, a.listingId)).toBe(404);
    expect(await bundleZipStatus(memberId, a.bundleId)).toBe(404);
    expect(await searchedNames(memberId)).not.toContain(a.skillName);
  });

  it('answers 422 for a feed request that names both an org and a Space, or neither', async () => {
    const { memberId, a } = await seed();
    expect((await call(feedHandler, memberId, { spaceId: a.spaceId, orgId: 'o1' })).statusCode).toBe(422);
    expect((await call(feedHandler, memberId, {})).statusCode).toBe(422);
  });
});

describe('Space admin review', () => {
  it('lists a pending Space version for the Space admin, and for nobody else in the Space', async () => {
    const owner = await newUser('owner');
    const admin = await newUser('admin');
    const plain = await newUser('plain');
    const space = await Space.create({
      name: 'acme',
      ownerUserId: owner.id,
      members: [
        { userId: admin.id, role: 'admin', ...joined },
        { userId: plain.id, role: 'member', ...joined },
      ],
    });
    const listing = await SkillListing.create({
      sourceSkillId: new mongoose.Types.ObjectId().toString(),
      authorUserId: plain.id,
      visibility: 'space',
      spaceId: String(space._id),
      status: 'in_review',
      name: 'held-skill',
      description: 'd',
    });
    const version = await SkillListingVersion.create({
      listingId: listing.id,
      version: 1,
      snapshot: { name: 'held-skill', description: 'd', body: 'b' },
      contentHash: 'h',
      scanStatus: 'passed',
      reviewStatus: 'pending',
    });
    await SkillListing.updateOne({ _id: listing._id }, { $set: { pendingVersionId: version.id, pendingVersion: 1 } });

    const stranger = await newUser('stranger');
    const otherSpace = await Space.create({ name: 'globex', ownerUserId: stranger.id, members: [] });
    const otherListing = await SkillListing.create({
      sourceSkillId: new mongoose.Types.ObjectId().toString(),
      authorUserId: stranger.id,
      visibility: 'space',
      spaceId: String(otherSpace._id),
      status: 'in_review',
      name: 'other-held-skill',
      description: 'd',
    });
    const otherVersion = await SkillListingVersion.create({
      listingId: otherListing.id,
      version: 1,
      snapshot: { name: 'other-held-skill', description: 'd', body: 'b' },
      contentHash: 'h2',
      scanStatus: 'passed',
      reviewStatus: 'pending',
    });
    await SkillListing.updateOne(
      { _id: otherListing._id },
      { $set: { pendingVersionId: otherVersion.id, pendingVersion: 1 } }
    );

    const asAdmin = await call(reviewQueueHandler, admin.id, {});
    expect(asAdmin.statusCode).toBe(200);
    expect((asAdmin.res._getJSONData() as { data: { version: { id: string } }[] }).data.map(r => r.version.id)).toEqual(
      [version.id]
    );
    expect((await call(reviewQueueHandler, owner.id, {})).statusCode).toBe(200);
    expect((await call(reviewQueueHandler, plain.id, {})).statusCode).toBe(403);
  });
});
