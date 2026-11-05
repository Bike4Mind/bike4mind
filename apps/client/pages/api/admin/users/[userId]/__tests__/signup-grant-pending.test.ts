import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  findById: vi.fn(),
  totals: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (config: unknown) => {
    h.config = config;
    return {
      get: (fn: typeof h.handler) => {
        h.handler = fn;
        return {};
      },
    };
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  userRepository: { findById: h.findById },
  heldCreditRewardRepository: { totalsForUser: h.totals },
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  resolveSignupGrantSchedule: h.schedule,
}));
await import('../signup-grant-pending');

const run = (
  query: Record<string, string> = { userId: 'user-1' },
  user: unknown = { id: 'admin-1', isAdmin: true }
) => {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as unknown as Record<string, unknown>).user = user;
  return { res, promise: h.handler!(req, res) };
};

describe('admin signup grant pending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.schedule.mockResolvedValue({ dripCap: 900, dailyCredits: 50 });
    h.totals.mockResolvedValue({ held: { count: 1, credits: 25 }, paused: { count: 0, credits: 0 } });
    h.findById.mockResolvedValue({
      id: 'user-1',
      tags: [],
      signupGrant: {
        stage: 'signup',
        signupCredits: 100,
        unlockCredits: 900,
        creditsReleased: 300,
        nextCondition: 'verification',
        blocked: { at: new Date('2026-11-04T09:00:00Z') },
      },
    });
  });

  it('is jwt-only and gated on the credits permission for GET', () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', adminPermissions: { GET: 'credits:adjust' } });
  });

  it('returns the block flag, the queued rewards and the action states', async () => {
    const { res, promise } = run();
    await promise;
    const body = res._getJSONData();
    expect(body.blocked).toEqual({ at: '2026-11-04T09:00:00.000Z' });
    expect(body.rewards).toMatchObject({ queuedCount: 1, queuedCredits: 25 });
    expect(body.actions.unblock.available).toBe(true);
    expect(h.totals).toHaveBeenCalledExactlyOnceWith('user-1');
  });

  it('lowercases the id before looking the account up', async () => {
    const { promise } = run({ userId: 'USER-1' });
    await promise;
    expect(h.findById).toHaveBeenCalledWith('user-1');
  });

  it('does not let a delegated admin run release-remaining', async () => {
    const { res, promise } = run({ userId: 'user-1' }, { id: 'delegate-1', isAdmin: false });
    await promise;
    expect(res._getJSONData().actions.releaseRemaining.permitted).toBe(false);
  });

  it('rejects an unknown account and a malformed id', async () => {
    h.findById.mockResolvedValue(null);
    await expect(run().promise).rejects.toThrow('User not found');
    await expect(run({}).promise).rejects.toThrow('Invalid user ID');
  });
});
