import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';

/**
 * POST /api/oauth/device/verify feeds the browser approval screen's device_info.
 * It must name the client that actually initiated the flow - the response used
 * to hardcode the CLI, which would have lied to anyone approving a desktop
 * request.
 */

const h = vi.hoisted(() => ({
  findByUserCode: vi.fn(),
  findOneAndUpdate: vi.fn(async () => ({ id: 'auth-1' })), // non-null = transition fired
  decrementCounter: vi.fn().mockResolvedValue(0),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {
      use: () => chain,
      post: (fn: (req: unknown, res: unknown) => unknown) => (req: unknown, res: unknown) => fn(req, res),
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/utils/oauth/deviceAuthHelpers', () => ({
  LIVE_PENDING_COUNTER_KEY: 'device-auth:live-pending-count',
}));
vi.mock('@bike4mind/common', () => ({
  LEGACY_DEVICE_CLIENT_ID: 'b4m-cli',
  oauthClientDisplayName: (id: string) => (id === 'b4m-cli' ? 'B4M CLI' : id === 'b4m-desktop' ? 'B4M Desktop' : id),
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { decrementCounter: h.decrementCounter },
  deviceAuthorizationRepository: { findByUserCode: h.findByUserCode },
  DeviceAuthorizationModel: { findOneAndUpdate: h.findOneAndUpdate },
}));

import handler from '../verify';

type DeviceInfo = { client_type?: string; client_name?: string; ip_address?: string };
type Res = {
  statusCode: number;
  body?: { success?: boolean; device_info?: DeviceInfo };
  status: (c: number) => Res;
  json: (b: unknown) => Res;
};
function mockRes(): Res {
  const res = { statusCode: 200 } as Res;
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b as Res['body'];
    return res;
  };
  return res;
}

const call = () => {
  const res = mockRes();
  const req = { body: { user_code: 'WXYZ-1234', action: 'approve' }, user: { id: 'u1' } };
  return (handler as unknown as (req: unknown, res: Res) => Promise<unknown>)(req, res).then(() => res);
};

const pendingFor = (clientId?: string) => ({
  id: 'auth-1',
  clientId,
  verificationAttempts: 0,
  ipAddress: '127.0.0.1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
});

describe('POST /api/oauth/device/verify consent screen client', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('reports the CLI when the CLI initiated the flow', async () => {
    (h.findByUserCode as Mock).mockResolvedValue(pendingFor('b4m-cli'));

    const res = await call();

    expect(res.body?.device_info?.client_type).toBe('b4m-cli');
    expect(res.body?.device_info?.client_name).toBe('B4M CLI');
  });

  it('reports the desktop app when the desktop app initiated the flow', async () => {
    (h.findByUserCode as Mock).mockResolvedValue(pendingFor('b4m-desktop'));

    const res = await call();

    expect(res.body?.device_info?.client_type).toBe('b4m-desktop');
    expect(res.body?.device_info?.client_name).toBe('B4M Desktop');
  });

  it('reads a row predating the clientId field as the CLI', async () => {
    (h.findByUserCode as Mock).mockResolvedValue(pendingFor(undefined));

    const res = await call();

    expect(res.body?.device_info?.client_type).toBe('b4m-cli');
  });
});

describe('POST /api/oauth/device/verify live-pending counter decrement', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const callWith = (action: 'approve' | 'deny') => {
    const res = mockRes();
    const req = { body: { user_code: 'WXYZ-1234', action }, user: { id: 'u1' } };
    return (handler as unknown as (req: unknown, res: Res) => Promise<unknown>)(req, res).then(() => res);
  };

  it('decrements the live-pending counter once when approving', async () => {
    (h.findByUserCode as Mock).mockResolvedValue(pendingFor('b4m-cli'));
    (h.findOneAndUpdate as Mock).mockResolvedValue({ id: 'auth-1' });

    await callWith('approve');

    expect(h.decrementCounter).toHaveBeenCalledTimes(1);
  });

  it('decrements the live-pending counter once when denying', async () => {
    (h.findByUserCode as Mock).mockResolvedValue(pendingFor('b4m-cli'));
    (h.findOneAndUpdate as Mock).mockResolvedValue({ id: 'auth-1' });

    await callWith('deny');

    expect(h.decrementCounter).toHaveBeenCalledTimes(1);
  });

  it('does not decrement when findOneAndUpdate returns null (concurrent double-verify guard)', async () => {
    (h.findByUserCode as Mock).mockResolvedValue(pendingFor('b4m-cli'));
    // null = another concurrent verify already transitioned the doc; status:'pending' guard matched nothing
    (h.findOneAndUpdate as Mock).mockResolvedValue(null);

    await callWith('approve');

    expect(h.decrementCounter).not.toHaveBeenCalled();
  });

  it('does not decrement when the authorization is not found', async () => {
    (h.findByUserCode as Mock).mockResolvedValue(null);

    const res = await callWith('approve');

    expect(res.statusCode).toBe(404);
    expect(h.decrementCounter).not.toHaveBeenCalled();
  });
});
