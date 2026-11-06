import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import {
  PENDING_FREE_CREDITS_TAG,
  resolveSignupGrantSchedule,
  signupGrantRemaining,
  type SignupGrant,
} from '@bike4mind/common';
import { adminSettingsRepository, heldCreditRewardRepository, User } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

// Real adminApi permission gate; only the transport (baseApi) is stubbed so the middleware runs in-line.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    let get: ((req: unknown, res: unknown) => unknown) | undefined;
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return get?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((get = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

import handler from '../pending';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
let dripCap = 0;

const oid = (n: number) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
const grant = (over: Record<string, unknown> = {}) => ({
  stage: 'signup',
  signupCredits: 100,
  unlockCredits: 200,
  creditsReleased: 100,
  ...over,
});
const at = new Date('2026-01-01T00:00:00Z');
const seed: Array<Record<string, unknown> & { key: string; _id: mongoose.Types.ObjectId }> = [
  {
    key: 'heldBudget',
    _id: oid(1),
    signupGrantHeldReason: 'budget_exhausted',
    signupGrantHeldAt: at,
    pendingCreditGrant: 40,
    tags: [PENDING_FREE_CREDITS_TAG],
    signupGrant: grant({ creditsReleased: 0 }),
  },
  {
    key: 'heldRisk',
    _id: oid(2),
    signupGrantHeldReason: 'risk_review',
    tags: [PENDING_FREE_CREDITS_TAG],
    signupGrant: grant({ creditsReleased: 0 }),
  },
  { key: 'dripping', _id: oid(3), signupGrant: grant({ creditsReleased: 150, dripCredits: 50 }) },
  {
    key: 'fullyDripped',
    _id: oid(4),
    signupGrant: grant({ stage: 'unlocked', unlockedBy: 'verification', creditsReleased: 300 }),
  },
  { key: 'blocked', _id: oid(5), signupGrant: grant({ blocked: { at } }) },
  {
    key: 'invited',
    _id: oid(6),
    referredByUserId: 'inviter-1',
    signupGrant: grant({ inviteBonusPaid: 25, creditsReleased: 125 }),
  },
  { key: 'package', _id: oid(7), grantPackageId: 'pkg-1', signupGrant: grant({ creditsReleased: 250 }) },
  { key: 'noGrant', _id: oid(8) },
  { key: 'pendingEmail', _id: oid(9), signupGrant: grant({ stage: 'pending_email', creditsReleased: 0 }) },
];
const idOf = (key: string) => String(seed.find(s => s.key === key)!._id);

const call = async (
  query: Record<string, string> = {},
  user: Record<string, unknown> = { id: 'admin-1', isAdmin: true }
) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger: { warn: vi.fn(), error: vi.fn() } });
  await handler(req as never, res as never);
  return res._getJSONData() as {
    data: Array<{ id: string; remaining: number; status: string; rewards: Record<string, number> }>;
    nextCursor: string | null;
    viewer: { canRelease: boolean };
  };
};
const ids = async (query: Record<string, string>) => (await call(query)).data.map(row => row.id);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await User.collection.insertMany(
    seed.map(({ key, ...doc }) => ({ ...doc, email: `${key}@example.com`, username: key, createdAt: at }))
  );
  const reward = (transactionId: string, credits: number) => ({
    transactionId,
    userId: idOf('dripping'),
    credits,
    source: 'gear' as const,
    reason: 'test',
    description: 'test reward',
  });
  await heldCreditRewardRepository.hold(reward('tx-1', 10));
  await heldCreditRewardRepository.hold(reward('tx-2', 15));
  await heldCreditRewardRepository.pauseOne('tx-2');
  ({ dripCap } = await resolveSignupGrantSchedule(adminSettingsRepository));
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('GET /api/admin/signup-grants/pending', () => {
  it('lists held, dripping, blocked, invited, package and locked accounts with the profile card remaining math', async () => {
    const { data, nextCursor, viewer } = await call();
    expect(data.map(row => row.id)).toEqual(
      ['heldBudget', 'heldRisk', 'dripping', 'blocked', 'invited', 'package', 'pendingEmail'].map(idOf)
    );
    for (const row of data) {
      const seeded = seed.find(s => String(s._id) === row.id)!;
      expect(row.remaining).toBe(signupGrantRemaining(seeded.signupGrant as SignupGrant, dripCap));
    }
    expect(data.find(row => row.id === idOf('dripping'))!.rewards).toEqual({
      queuedCount: 1,
      queuedCredits: 10,
      pausedCount: 1,
      pausedCredits: 15,
    });
    expect(data.find(row => row.id === idOf('heldBudget'))).toMatchObject({
      status: 'held',
      held: { reason: 'budget_exhausted', since: at.toISOString(), credits: 40 },
    });
    expect(nextCursor).toBeNull();
    expect(viewer).toEqual({ canRelease: true });
  });

  it('applies each filter', async () => {
    expect(await ids({ status: 'blocked' })).toEqual([idOf('blocked')]);
    expect(await ids({ status: 'held' })).toEqual([idOf('heldBudget'), idOf('heldRisk')]);
    expect(await ids({ heldReason: 'risk_review' })).toEqual([idOf('heldRisk')]);
    expect(await ids({ source: 'package' })).toEqual([idOf('package')]);
    expect(await ids({ source: 'default' })).not.toContain(idOf('package'));
    expect(await ids({ status: 'locked' })).toEqual([idOf('pendingEmail')]);
    expect(await ids({ status: 'dripping' })).toEqual(['dripping', 'invited', 'package'].map(idOf));
  });

  it('sorts by remaining descending when asked', async () => {
    const { data } = await call({ sort: 'remaining' });
    expect(data.map(row => row.remaining)).toEqual([...data.map(row => row.remaining)].sort((a, b) => b - a));
  });

  it.each(['oldest', 'remaining'])('pages disjointly through a cursor (%s)', async sort => {
    const first = await call({ sort, limit: '3' });
    expect(first.data).toHaveLength(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await call({ sort, limit: '3', cursor: first.nextCursor! });
    const firstIds = first.data.map(row => row.id);
    expect(second.data.length).toBeGreaterThan(0);
    for (const row of second.data) expect(firstIds).not.toContain(row.id);
    const seen = [...firstIds, ...second.data.map(row => row.id)];
    for (let cursor = second.nextCursor; cursor;) {
      const page = await call({ sort, limit: '3', cursor });
      seen.push(...page.data.map(row => row.id));
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual((await ids({ sort })).sort());
  });

  it('returns the empty shape when nothing matches', async () => {
    const result = await call({ heldReason: 'risk_review', source: 'package' });
    expect({ data: result.data, nextCursor: result.nextCursor }).toEqual({ data: [], nextCursor: null });
  });

  it('rejects a malformed cursor, a cursor from the other sort and an out-of-range limit', async () => {
    const oldestCursor = (await call({ limit: '1' })).nextCursor!;
    for (const query of [
      { cursor: 'not-a-cursor' },
      { cursor: Buffer.from('{"s":"oldest","id":"zz"}').toString('base64url') },
      { sort: 'remaining', cursor: oldestCursor },
      { limit: '0' },
      { limit: '101' },
      { limit: 'abc' },
      { status: 'everything' },
    ]) {
      await expect(call(query), JSON.stringify(query)).rejects.toMatchObject({ name: 'BadRequestError' });
    }
  });

  it('refuses a non-admin and a delegated admin without the credits permission', async () => {
    await expect(call({}, { id: 'user-1', isAdmin: false })).rejects.toMatchObject({ name: 'ForbiddenError' });
    await expect(call({}, { id: 'user-1', adminPermissions: ['users:view'] })).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
  });

  it('serves a delegated credits admin but does not offer bulk release', async () => {
    const result = await call({}, { id: 'user-1', adminPermissions: ['credits:adjust'] });
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.viewer).toEqual({ canRelease: false });
  });
});
