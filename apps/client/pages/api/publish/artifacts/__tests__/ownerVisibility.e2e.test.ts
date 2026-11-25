import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import { z } from 'zod';
import { Project, PublishedArtifact, User } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

type ListHandler = (request: Request, response: Response) => Promise<unknown>;
const route = vi.hoisted(() => ({ handler: null as ListHandler | null, ownerGate: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (handler: ListHandler) => {
      route.handler = handler;
      return {};
    },
  }),
}));
vi.mock('@server/services/publish', async () => {
  const visibility = await import('@server/services/publish/buildListFilter');
  const query = await import('@server/services/publish/buildListQuery');
  const owners = await import('@server/services/publish/loadLiveOwner');
  return {
    ...visibility,
    ...query,
    excludeNonLiveOwners: route.ownerGate.mockImplementation(owners.excludeNonLiveOwners),
  };
});
vi.mock('@server/services/publish/thumbnailUrl', () => ({ signOwnerThumbnailUrl: vi.fn() }));

import '@pages/api/publish/artifacts';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let mongo: Awaited<ReturnType<typeof createMongoServer>>;
const CALLER = '650000000000000000000001';
const LIVE = 'abcdef000000000000000002';
const BANNED = '650000000000000000000003';
const SUSPENDED = '650000000000000000000004';
const NULL_FLAGS = '650000000000000000000005';
const MISSING_FLAGS = '650000000000000000000006';
const DISPUTE = '650000000000000000000007';
const GONE = '650000000000000000000008';
const VISIBLE = ['own', 'live-uppercase', 'live-bson', 'null-flags', 'missing-flags', 'dispute'];
const responseSchema = z.object({ artifacts: z.array(z.object({ title: z.string() })), total: z.number() });

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
  await Promise.all([User.init(), Project.init(), PublishedArtifact.init()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([User.deleteMany({}), Project.deleteMany({}), PublishedArtifact.deleteMany({})]);
  const users: Record<string, unknown>[] = [
    { _id: new Types.ObjectId(CALLER) },
    { _id: new Types.ObjectId(LIVE) },
    { _id: new Types.ObjectId(BANNED), isBanned: true },
    { _id: new Types.ObjectId(SUSPENDED), moderation: { status: 'suspended' } },
    { _id: new Types.ObjectId(NULL_FLAGS), isBanned: null, moderation: null },
    { _id: new Types.ObjectId(MISSING_FLAGS) },
    { _id: new Types.ObjectId(DISPUTE), disputePending: true, moderation: { status: 'suspend_pending' } },
  ];
  // Raw writes exercise legacy BSON owner IDs and optional fields without schema casting/defaults.
  await mongoose.connection
    .db!.collection<Record<string, unknown>>(User.collection.name)
    .insertMany(users.map((user, index) => ({ ...user, username: `visibility-${index}` })));
  const artifact = (title: string, ownerId: unknown) => ({
    _id: new Types.ObjectId(),
    publicId: `test-${title}`,
    title,
    ownerId,
    tier: 'user',
    scopeId: CALLER,
    slug: title,
    visibility: title === 'own' ? 'private' : 'public',
    source: { kind: 'bundle', artifactId: `source-${title}` },
    versions: [],
    deletedAt: null,
    publishedAt: new Date('2026-11-12T00:00:00Z'),
  });
  await mongoose.connection
    .db!.collection<Record<string, unknown>>(PublishedArtifact.collection.name)
    .insertMany([
      artifact('own', CALLER),
      artifact('live-uppercase', LIVE.toUpperCase()),
      artifact('live-bson', new Types.ObjectId(LIVE)),
      artifact('null-flags', NULL_FLAGS),
      artifact('missing-flags', MISSING_FLAGS),
      artifact('dispute', DISPUTE),
      artifact('blocked-banned', BANNED),
      artifact('blocked-bson', new Types.ObjectId(BANNED)),
      artifact('blocked-suspended', SUSPENDED),
      artifact('blocked-gone', GONE),
      artifact('blocked-gone-bson', new Types.ObjectId(GONE)),
    ]);
});

async function list(query: Record<string, string> = {}, isAdmin = false) {
  const { req, res } = createMocks<Request, Response>({ method: 'GET', query });
  Object.assign(req, { user: { id: CALLER, isAdmin } });
  if (!route.handler) throw new Error('Missing artifact list handler');
  await route.handler(req, res);
  expect(res._getStatusCode()).toBe(200);
  return responseSchema.parse(res._getJSONData());
}

describe('published artifact owner visibility with real Mongo', () => {
  it('keeps rows and total aligned for live, banned, suspended and missing owners', async () => {
    const result = await list();
    expect(result.total).toBe(VISIBLE.length);
    expect(result.artifacts.map(row => row.title).sort()).toEqual([...VISIBLE].sort());
    expect(route.ownerGate).toHaveBeenCalledOnce();
  });

  it('counts the same eligible rows before paging', async () => {
    const result = await list({ limit: '2', skip: '2' });
    expect(result.total).toBe(VISIBLE.length);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every(row => VISIBLE.includes(row.title))).toBe(true);
  });

  it('keeps caller narrowing and excludes raw BSON banned-owner rows from the count', async () => {
    expect(await list({ q: 'blocked' })).toMatchObject({ artifacts: [], total: 0 });
  });

  it('preserves the administrator bypass', async () => {
    const result = await list({}, true);
    expect(result.total).toBe(11);
    expect(result.artifacts).toHaveLength(11);
    expect(route.ownerGate).not.toHaveBeenCalled();
  });

  it('preserves the owner listing bypass', async () => {
    await User.updateOne({ _id: CALLER }, { $set: { isBanned: true } });
    expect(await list({ mine: 'true' })).toMatchObject({ artifacts: [{ title: 'own' }], total: 1 });
    expect(route.ownerGate).not.toHaveBeenCalled();
  });

  it('preserves owner-scoped source lookups', async () => {
    expect(await list({ sourceArtifactId: 'source-own' })).toMatchObject({ artifacts: [{ title: 'own' }], total: 1 });
    expect(route.ownerGate).not.toHaveBeenCalled();
  });
});
