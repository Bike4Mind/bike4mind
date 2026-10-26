import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The global poll ceiling is keyed on a constant: IP headers and device_code are both
 * caller-rotatable. It answers slow_down (not 429) so the CLI backs off instead of aborting.
 */

const mockRefs = vi.hoisted(() => ({ handler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: () => chain,
      post: (fn: any) => {
        mockRefs.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/auth/issueSession', () => ({ issueSessionForRequest: vi.fn() }));
vi.mock('@server/auth/tokenGenerator', () => ({ ACCESS_TOKEN_TTL_SECONDS: 3600 }));

const repo = vi.hoisted(() => ({ findByDeviceCode: vi.fn(), recordPollIfDue: vi.fn(), claimApproved: vi.fn() }));
const tryIncrement = vi.hoisted(() => vi.fn());
const userFindById = vi.hoisted(() => vi.fn());
const isApiKeyAccessAllowedMock = vi.hoisted(() => vi.fn(async (_user: unknown) => true));
vi.mock('@bike4mind/database', () => ({
  deviceAuthorizationRepository: repo,
  cacheRepository: { tryIncrementWithinLimitFixedWindow: tryIncrement },
  userRepository: { findById: userFindById },
}));
vi.mock('@server/utils/apiKeyAccessGate', () => ({
  CLI_ACCESS_DENIED_MESSAGE: 'The CLI and desktop app require an active paid subscription',
  SUBSCRIPTION_REQUIRED_ERROR: 'subscription_required',
  isApiKeyAccessAllowed: isApiKeyAccessAllowedMock,
}));

import '../token';

function request(deviceCode: string, ip = '203.0.113.1') {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const req: any = {
    body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: 'b4m-cli' },
    headers: { 'x-forwarded-for': ip, 'cloudfront-viewer-address': `${ip}:443` },
    socket: { remoteAddress: ip },
    logger: { warn: vi.fn() },
  };
  return { req, res };
}

describe('POST /api/oauth/device/token global poll ceiling', () => {
  beforeEach(() => {
    repo.findByDeviceCode.mockReset();
    repo.recordPollIfDue.mockReset();
    repo.claimApproved.mockReset();
    repo.recordPollIfDue.mockResolvedValue({});
    tryIncrement.mockReset();
  });

  it('answers slow_down without a lookup once the global window is exhausted', async () => {
    tryIncrement.mockResolvedValue({ success: false });
    const { req, res } = request('dc-1');
    await mockRefs.handler!(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'slow_down' });
    expect(req.logger.warn).toHaveBeenCalledTimes(1);
    expect(repo.findByDeviceCode).not.toHaveBeenCalled();
  });

  it('uses the same key regardless of IP headers and device_code', async () => {
    tryIncrement.mockResolvedValue({ success: false });
    for (const [code, ip] of [
      ['dc-a', '198.51.100.1'],
      ['dc-b', '198.51.100.2'],
    ]) {
      const { req, res } = request(code, ip);
      await mockRefs.handler!(req, res);
    }
    expect(tryIncrement.mock.calls).toEqual([
      ['rate-limit:device-token-global', 6000, 60_000],
      ['rate-limit:device-token-global', 6000, 60_000],
    ]);
  });

  it('keeps pending behavior under the ceiling', async () => {
    tryIncrement.mockResolvedValue({ success: true });
    repo.findByDeviceCode.mockResolvedValue({
      id: 'auth-1',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      lastPolledAt: null,
      pollCount: 2,
    });
    const { req, res } = request('dc-1');
    await mockRefs.handler!(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'authorization_pending' });
    expect(repo.recordPollIfDue).toHaveBeenCalledWith('auth-1', 5000);
  });

  it('keeps expired and unknown-code behavior under the ceiling', async () => {
    tryIncrement.mockResolvedValue({ success: true });
    repo.findByDeviceCode.mockResolvedValueOnce({ id: 'a', status: 'pending', expiresAt: new Date(Date.now() - 1) });
    const expired = request('dc-old');
    await mockRefs.handler!(expired.req, expired.res);
    expect(expired.res.body).toMatchObject({ error: 'expired_token' });

    repo.findByDeviceCode.mockResolvedValueOnce(null);
    const unknown = request('dc-nope');
    await mockRefs.handler!(unknown.req, unknown.res);
    expect(unknown.res.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('answers slow_down when the poll is not due', async () => {
    tryIncrement.mockResolvedValue({ success: true });
    repo.findByDeviceCode.mockResolvedValue({
      id: 'auth-1',
      status: 'approved',
      userId: 'u1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    repo.recordPollIfDue.mockResolvedValue(null);
    const { req, res } = request('dc-1');
    await mockRefs.handler!(req, res);
    expect(res.body).toMatchObject({ error: 'slow_down' });
    expect(repo.claimApproved).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/device/token paid-only access switch', () => {
  it('refuses to issue a session for an approved code when the setting denies the user', async () => {
    tryIncrement.mockResolvedValue({ success: true });
    repo.findByDeviceCode.mockResolvedValue({
      id: 'auth-1',
      status: 'approved',
      userId: 'u1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    repo.recordPollIfDue.mockResolvedValue({ id: 'auth-1' });
    repo.claimApproved.mockClear();
    userFindById.mockResolvedValue({ id: 'u1' });
    isApiKeyAccessAllowedMock.mockResolvedValueOnce(false);

    const { req, res } = request('dc-1');
    await mockRefs.handler!(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: 'subscription_required',
      error_description: 'The CLI and desktop app require an active paid subscription',
    });
    expect(repo.claimApproved).not.toHaveBeenCalled();
  });
});
