import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ timeseries: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (handler: unknown) => handler }) }));
vi.mock('@server/users/signupTimeseries', () => ({ getSignupTimeseries: mocks.timeseries }));
import handler from '../signup-timeseries';

describe('signup time-series route', () => {
  const run = async (isAdmin: boolean, query: Record<string, string> = {}) => {
    const { req, res } = createMocks({ query });
    Object.assign(req, { user: { isAdmin } });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    return res;
  };
  beforeEach(() => {
    mocks.timeseries.mockReset();
    mocks.timeseries.mockResolvedValue({ range: '7d' });
  });

  it('rejects non-admins before reading anything', async () => {
    expect((await run(false))._getStatusCode()).toBe(403);
    expect(mocks.timeseries).not.toHaveBeenCalled();
  });

  it('rejects a range outside the supported set', async () => {
    expect((await run(true, { range: '1y' }))._getStatusCode()).toBe(400);
    const badOffset = await run(true, { range: '7d', tzOffset: '9999' });
    expect(badOffset._getStatusCode()).toBe(400);
    expect(badOffset._getJSONData().message).toContain('tzOffset');
    expect(mocks.timeseries).not.toHaveBeenCalled();
  });

  it('passes the range and offset through and never caches', async () => {
    const res = await run(true, { range: '7d', tzOffset: '-300' });
    expect(mocks.timeseries).toHaveBeenCalledWith({ range: '7d', tzOffsetMinutes: -300 });
    expect(res._getJSONData()).toEqual({ range: '7d' });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('defaults to 30 days in UTC', async () => {
    await run(true);
    expect(mocks.timeseries).toHaveBeenCalledWith({ range: '30d', tzOffsetMinutes: 0 });
  });
});
