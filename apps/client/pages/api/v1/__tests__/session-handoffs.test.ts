import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  contracts: [] as { operationId: string; auth: string }[],
  send: vi.fn(),
  list: vi.fn(),
}));
vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: { operationId: string; auth: string }) => {
    h.contracts.push(contract);
    return {
      get: (handler: unknown) => handler,
      post: (handler: unknown) => handler,
    };
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@server/sessions/sessionHandoffAdapters', () => ({ sessionHandoffAdapters: {} }));
vi.mock('@server/sessions/sessionHandoff', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/sessions/sessionHandoff')>()),
  sendSessionHandoff: h.send,
  listHandoffDevices: h.list,
}));

import send from '../session-handoffs';
import list from '../handoff-devices';
import { InactiveHandoffDeviceError } from '@server/sessions/sessionHandoff';

const sessionId = '0123456789abcdef01234567';
const call = async (handler: unknown, sid: string | undefined = 'signed-in') => {
  const { req, res } = createMocks();
  Object.assign(req, { user: { id: 'user', sid }, validated: { sessionId, deviceId: 'live:one' } });
  await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
};

describe('handoff route boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.list.mockResolvedValue([]);
    h.send.mockResolvedValue(undefined);
  });
  it('uses JWT-only shared contracts for both routes', () => {
    expect(h.contracts).toEqual(
      [
        { operationId: 'sendSessionHandoff', auth: 'jwtOnly' },
        { operationId: 'listHandoffDevices', auth: 'jwtOnly' },
      ].map(expected => expect.objectContaining(expected))
    );
  });
  it('does not list or send from a sessionless token', async () => {
    const { req, res } = createMocks();
    Object.assign(req, { user: { id: 'user' }, validated: { sessionId, deviceId: 'live:one' } });
    await expect((send as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res)).rejects.toThrow(
      /Sign in again/
    );
    await expect((list as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res)).rejects.toThrow(
      /Sign in again/
    );
  });
  it('never caches device listings and scopes them to the caller', async () => {
    const res = await call(list);
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(h.list).toHaveBeenCalledWith('user', {});
    expect(res._getJSONData()).toEqual({ devices: [] });
  });
  it('returns inactive feedback without session content', async () => {
    h.send.mockRejectedValue(new InactiveHandoffDeviceError());
    const res = await call(send);
    expect(res.statusCode).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'This device looks inactive. Open it, sign in, and try again.' });
  });
});
