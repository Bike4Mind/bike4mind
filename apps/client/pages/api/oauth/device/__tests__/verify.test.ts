import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

/**
 * POST /api/oauth/device/verify feeds the browser approval screen's device_info.
 * It must name the client that actually initiated the flow - the response used
 * to hardcode the CLI, which would have lied to anyone approving a desktop
 * request.
 */

const h = vi.hoisted(() => ({
  findByUserCode: vi.fn(),
  findByIdAndUpdate: vi.fn(async () => undefined),
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
vi.mock('@bike4mind/database', () => ({
  deviceAuthorizationRepository: { findByUserCode: h.findByUserCode },
  DeviceAuthorizationModel: { findByIdAndUpdate: h.findByIdAndUpdate },
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

  it('reports the CLI when the CLI initiated the flow', async () => {
    (h.findByUserCode as Mock).mockResolvedValue(pendingFor('b4m-cli'));

    const res = await call();

    expect(res.body?.device_info?.client_type).toBe('b4m-cli');
    expect(res.body?.device_info?.client_name).toBe('the B4M CLI');
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
