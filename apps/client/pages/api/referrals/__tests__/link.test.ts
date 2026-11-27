import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  baseApiOptions: vi.fn(),
  getOrCreate: vi.fn(),
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
vi.mock('@server/referrals/shareLink', () => ({
  getOrCreateReferralCode: h.getOrCreate,
  referralLinkUrl: (code: string) => `https://app.example.test/r/${code}`,
}));

await import('../link');

const makeRes = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

describe('GET /api/referrals/link', () => {
  beforeEach(() => {
    h.getOrCreate.mockReset().mockResolvedValue('abcd2345');
  });

  it('refuses API keys by requiring a session token', () => {
    expect(h.baseApiOptions).toHaveBeenCalledWith({ auth: 'jwtOnly' });
  });

  it("returns the signed-in user's own link", async () => {
    const res = makeRes();
    await h.handler!({ user: { id: 'u1', emailVerified: true } }, res);
    expect(h.getOrCreate).toHaveBeenCalledWith('u1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ code: 'abcd2345', url: 'https://app.example.test/r/abcd2345' });
  });

  it('serves an account whose email a sign-in provider vouched for', async () => {
    const res = makeRes();
    await h.handler!({ user: { id: 'u2', emailVerified: false, authProviders: [{ strategy: 'github' }] } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('refuses an unverified account before minting a code', async () => {
    await expect(
      h.handler!({ user: { id: 'u3', emailVerified: false, authProviders: [] } }, makeRes())
    ).rejects.toThrow('Please verify your email address to get a share link');
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });
});
