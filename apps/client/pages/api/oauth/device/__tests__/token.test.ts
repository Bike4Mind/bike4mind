import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

/**
 * POST /api/oauth/device/token: the allowlist must admit every known client, and
 * a device code must only be redeemable by the client it was issued to
 * (RFC 8628 s3.4) - the approval screen named that client.
 */

const h = vi.hoisted(() => ({
  findByDeviceCode: vi.fn(),
  update: vi.fn(async () => undefined),
  findById: vi.fn(async () => ({ id: 'u1', tokenVersion: 0 })),
  issueSessionForRequest: vi.fn(async () => ({ accessToken: 'a.jwt', refreshToken: 'r.jwt' })),
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
  deviceAuthorizationRepository: { findByDeviceCode: h.findByDeviceCode, update: h.update },
  userRepository: { findById: h.findById },
}));
vi.mock('@server/auth/issueSession', () => ({ issueSessionForRequest: h.issueSessionForRequest }));
vi.mock('@server/auth/tokenGenerator', () => ({ ACCESS_TOKEN_TTL_SECONDS: 1800 }));

import handler from '../token';

type Res = {
  statusCode: number;
  body?: { error?: string; error_description?: string; access_token?: string };
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

const call = (clientId: unknown) => {
  const res = mockRes();
  const req = {
    body: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dc',
      client_id: clientId,
    },
  };
  return (handler as unknown as (req: unknown, res: Res) => Promise<unknown>)(req, res).then(() => res);
};

const approvedFor = (clientId?: string) => ({
  id: 'auth-1',
  clientId,
  status: 'approved',
  userId: 'u1',
  expiresAt: new Date(Date.now() + 600_000),
  lastPolledAt: null,
  pollCount: 0,
});

describe('POST /api/oauth/device/token client binding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('still issues tokens for b4m-cli', async () => {
    (h.findByDeviceCode as Mock).mockResolvedValue(approvedFor('b4m-cli'));

    const res = await call('b4m-cli');

    expect(res.statusCode).toBe(200);
    expect(res.body?.access_token).toBe('a.jwt');
  });

  it('issues tokens for b4m-desktop', async () => {
    (h.findByDeviceCode as Mock).mockResolvedValue(approvedFor('b4m-desktop'));

    const res = await call('b4m-desktop');

    expect(res.statusCode).toBe(200);
    expect(res.body?.access_token).toBe('a.jwt');
  });

  it('refuses a code issued to another client, without advancing poll state', async () => {
    (h.findByDeviceCode as Mock).mockResolvedValue(approvedFor('b4m-cli'));

    const res = await call('b4m-desktop');

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid_grant');
    expect(h.update).not.toHaveBeenCalled();
    expect(h.issueSessionForRequest).not.toHaveBeenCalled();
  });

  it('reads a row predating the clientId field as the CLI', async () => {
    (h.findByDeviceCode as Mock).mockResolvedValue(approvedFor(undefined));

    expect((await call('b4m-cli')).statusCode).toBe(200);

    vi.clearAllMocks();
    (h.findByDeviceCode as Mock).mockResolvedValue(approvedFor(undefined));
    expect((await call('b4m-desktop')).statusCode).toBe(400);
  });

  it('rejects a client_id that is not on the allowlist', async () => {
    await expect(call('b4m-rogue')).rejects.toThrow();
    expect(h.findByDeviceCode).not.toHaveBeenCalled();
  });
});
