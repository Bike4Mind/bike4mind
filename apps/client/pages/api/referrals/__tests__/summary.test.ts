import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  getSummary: vi.fn(),
  baseApiOptions: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options?: unknown) => {
    h.baseApiOptions(options);
    return {
      get: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        h.handler = fn;
        return {};
      },
    };
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: <T>(fn: T) => fn }));
vi.mock('@server/referrals/inviterSummary', () => ({ getInviterSummary: h.getSummary }));

await import('../summary');

describe('GET /api/referrals/summary', () => {
  beforeEach(() => {
    h.getSummary.mockReset();
  });

  it('refuses API keys by requiring a session token', () => {
    expect(h.baseApiOptions).toHaveBeenCalledWith({ auth: 'jwtOnly' });
  });

  it("returns the signed-in user's own summary and nobody else's", async () => {
    const summary = { enabled: true, invited: 3, active: 2, subscribed: 1, creditsEarned: 7000, recentRewards: [] };
    h.getSummary.mockResolvedValue(summary);
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await h.handler!({ user: { id: 'inviter1' }, query: { userId: 'someone-else' } }, { status });

    expect(h.getSummary).toHaveBeenCalledExactlyOnceWith('inviter1');
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(summary);
  });
});
