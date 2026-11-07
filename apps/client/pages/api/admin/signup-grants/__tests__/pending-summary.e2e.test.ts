import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import {
  PENDING_FREE_CREDITS_TAG,
  resolveSignupGrantSchedule,
  signupGrantDripOpen,
  signupGrantDripRemaining,
  signupGrantRemaining,
  type SignupGrant,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  signupGrantBudgetRepository,
  signupGrantPendingRepository,
  User,
} from '@bike4mind/database';
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

import handler from '../pending-summary';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;

const oid = (n: number) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
const at = new Date('2026-01-01T00:00:00Z');
const later = new Date('2026-02-01T00:00:00Z');
const grant = (over: Record<string, unknown> = {}) => ({
  stage: 'signup',
  signupCredits: 100,
  unlockCredits: 200,
  creditsReleased: 100,
  ...over,
});
const seed = [
  {
    _id: oid(1),
    signupGrantHeldReason: 'budget_exhausted',
    signupGrantHeldAt: later,
    tags: [PENDING_FREE_CREDITS_TAG],
    signupGrant: grant({ creditsReleased: 0 }),
  },
  { _id: oid(2), signupGrantHeldReason: 'budget_exhausted', signupGrantHeldAt: at, tags: [PENDING_FREE_CREDITS_TAG] },
  { _id: oid(3), signupGrant: grant({ dripCredits: 50, creditsReleased: 150 }) },
  { _id: oid(4), signupGrant: grant({ stage: 'unlocked', unlockedBy: 'verification', creditsReleased: 300 }) },
  {
    _id: oid(5),
    signupGrantHeldReason: 'risk_review',
    signupGrantHeldAt: later,
    tags: [PENDING_FREE_CREDITS_TAG],
    signupGrant: grant(),
  },
  // Listed, but pay nothing without an admin, so they stay out of the exposure totals.
  { _id: oid(6), signupGrant: grant({ blocked: { at } }) },
  { _id: oid(7), signupGrant: grant({ unlockForfeited: { cause: 'payment_refunded', at } }) },
];
const unpaid = new Set([String(oid(6)), String(oid(7))]);

const call = async (warn = vi.fn()) => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: { id: 'admin-1', isAdmin: true }, logger: { warn, error: vi.fn() } });
  await handler(req as never, res as never);
  return res._getJSONData();
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('GET /api/admin/signup-grants/pending-summary', () => {
  it('reports zeros and an empty queue with no holders', async () => {
    const summary = await call();
    expect(summary.exposure).toEqual({ accountsWithRemaining: 0, totalRemaining: 0, totalDripRemaining: 0 });
    expect(summary.queue).toEqual({ held: 0, oldestHeldAt: null });
    expect(summary.trickle).toMatchObject({ spentToday: 0, limit: 0, missing: true });
  });

  it('totals exposure over accounts that can still be paid and reports the held queue across both reasons', async () => {
    await User.collection.insertMany(seed.map((doc, n) => ({ ...doc, email: `u${n}@example.com`, username: `u${n}` })));
    const { dripCap } = await resolveSignupGrantSchedule(adminSettingsRepository);
    const grants = seed
      .filter(doc => doc.signupGrant && !unpaid.has(String(doc._id)))
      .map(doc => doc.signupGrant) as SignupGrant[];
    expect(grants.length).toBe(seed.filter(doc => doc.signupGrant).length - 2);
    const remaining = grants.map(g => signupGrantRemaining(g, dripCap));

    const summary = await call();
    expect(summary.exposure.accountsWithRemaining).toBe(remaining.filter(r => r > 0).length);
    expect(summary.exposure.totalRemaining).toBe(remaining.reduce((a, b) => a + b, 0));
    expect(summary.exposure.totalDripRemaining).toBe(
      grants.reduce((sum, g) => sum + (signupGrantDripOpen(g) ? signupGrantDripRemaining(g, dripCap) : 0), 0)
    );
    // Both hold reasons count, matching the list's Held filter.
    expect(summary.queue).toEqual({ held: 3, oldestHeldAt: at.toISOString() });
  });

  it.each([
    { read: 'schedule', tile: 'exposure' },
    { read: 'exposure', tile: 'exposure' },
    { read: 'budget', tile: 'trickle' },
    { read: 'spend', tile: 'trickle' },
    { read: 'queue', tile: 'queue' },
  ] as const)('nulls only $tile and logs when the $read read fails', async ({ read, tile }) => {
    const baseline = await call();
    const error = new Error(`${read} read failed`);
    switch (read) {
      case 'schedule':
        vi.spyOn(adminSettingsRepository, 'findBySettingNames').mockRejectedValueOnce(error);
        break;
      case 'exposure':
        vi.spyOn(signupGrantPendingRepository, 'summarizePending').mockRejectedValueOnce(error);
        break;
      case 'budget':
        vi.spyOn(adminSettingsRepository, 'findBySettingName').mockRejectedValueOnce(error);
        break;
      case 'spend':
        vi.spyOn(signupGrantBudgetRepository, 'getSpent').mockRejectedValueOnce(error);
        break;
      case 'queue':
        vi.spyOn(signupGrantPendingRepository, 'heldQueue').mockRejectedValueOnce(error);
        break;
    }
    const warn = vi.fn();
    expect(await call(warn)).toEqual({ ...baseline, [tile]: null });
    expect(warn).toHaveBeenCalledExactlyOnceWith(`Pending summary: ${tile} read failed`, { error });
  });
});
