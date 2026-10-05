import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

/**
 * POST /api/oauth/device/initiate is the allowlist gate for the device flow: it
 * must accept every known first-party client and nothing else, and it must
 * persist which one asked so the approval screen can name it.
 *
 * baseApi/rateLimit are stubbed to pass-through so the exported handler is the
 * raw (req, res) function; only the repository seam is mocked.
 */

const h = vi.hoisted(() => ({
  create: vi.fn(async () => undefined),
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
  // Held well under the live-pending cap: that cap has its own tests in initiate.test.ts, and
  // this file is only about which client_id the route accepts.
  deviceAuthorizationRepository: { create: h.create, countPendingAndUnexpired: async () => 0 },
  digestDeviceCode: (c: string) => `digest:${c}`,
}));
vi.mock('@server/utils/oauth/deviceAuthHelpers', () => ({
  generateDeviceCode: () => 'device-code',
  generateUserCode: () => 'WXYZ-1234',
  MAX_LIVE_PENDING_DEVICE_AUTHORIZATIONS: 50,
}));
vi.mock('@server/utils/validators', () => ({ isLocalAppUrl: () => false }));

import handler from '../initiate';

type Res = {
  statusCode: number;
  body?: { user_code?: string; device_code?: string };
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

const call = (body: Record<string, unknown>) => {
  const res = mockRes();
  const req = { body, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  return (handler as unknown as (req: unknown, res: Res) => Promise<unknown>)(req, res).then(() => res);
};

describe('POST /api/oauth/device/initiate client allowlist', () => {
  beforeEach(() => vi.clearAllMocks());

  it('still accepts b4m-cli and records it as the requesting client', async () => {
    const res = await call({ client_id: 'b4m-cli' });

    expect(res.statusCode).toBe(200);
    expect(res.body?.user_code).toBe('WXYZ-1234');
    expect((h.create as Mock).mock.calls[0][0]).toMatchObject({ clientId: 'b4m-cli' });
  });

  it('accepts b4m-desktop and records it as the requesting client', async () => {
    const res = await call({ client_id: 'b4m-desktop' });

    expect(res.statusCode).toBe(200);
    expect((h.create as Mock).mock.calls[0][0]).toMatchObject({ clientId: 'b4m-desktop' });
  });

  it('rejects a client_id that is not on the allowlist', async () => {
    await expect(call({ client_id: 'b4m-rogue' })).rejects.toThrow();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('rejects a missing client_id', async () => {
    await expect(call({})).rejects.toThrow();
    expect(h.create).not.toHaveBeenCalled();
  });
});
