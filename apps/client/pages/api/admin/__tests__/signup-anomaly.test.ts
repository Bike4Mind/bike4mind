import { describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (handler: unknown) => handler }) }));
vi.mock('@server/users/signupAnomaly', () => ({ getSignupAnomalySnapshot: mocks.snapshot }));
import handler from '../signup-anomaly';

describe('signup anomaly route', () => {
  const run = async (isAdmin: boolean) => {
    const { req, res } = createMocks();
    Object.assign(req, { user: { isAdmin } });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    return res;
  };
  it('rejects non-admins before reading counts', async () => {
    mocks.snapshot.mockClear();
    expect((await run(false))._getStatusCode()).toBe(403);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it('returns a private uncached admin snapshot', async () => {
    mocks.snapshot.mockResolvedValue({ signupCount: 3 });
    const res = await run(true);
    expect(res._getJSONData()).toEqual({ signupCount: 3 });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
});
