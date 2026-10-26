import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TooManyRequestsError } from '@bike4mind/utils';
import type { Request, Response } from 'express';

const h = vi.hoisted(() => ({
  tryIncrement: vi.fn(),
  clientIp: vi.fn(),
  e2e: vi.fn(),
  settings: {} as Record<string, string>,
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrement },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => h.settings,
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: h.clientIp }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isE2EEnabled: h.e2e }));

import { oauthIpRateLimit } from './oauthIpRateLimit';

const makeReq = (accept = 'text/html', url = '/api/auth/google') =>
  ({ url, headers: { accept } }) as unknown as Request;
const makeRes = () =>
  ({ setHeader: vi.fn(), redirect: vi.fn() }) as unknown as Response & {
    setHeader: ReturnType<typeof vi.fn>;
    redirect: ReturnType<typeof vi.fn>;
  };

describe('oauthIpRateLimit', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.settings = {};
    h.clientIp.mockReturnValue('203.0.113.7');
    h.e2e.mockReturnValue(false);
    h.tryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
  });

  it('counts per bucket and IP with the default 40 per 10 minutes', async () => {
    const next = vi.fn();
    await oauthIpRateLimit('oauth-init')(makeReq(), makeRes(), next);
    expect(h.tryIncrement).toHaveBeenCalledWith('oauth-limit:oauth-init:203.0.113.7', 40, 600_000);
    expect(next).toHaveBeenCalledWith();
  });

  it('uses the admin-set limit and window', async () => {
    h.settings = { oauthRateLimitPerIp: '5', oauthRateLimitWindowMinutes: '2' };
    await oauthIpRateLimit('oauth-callback')(makeReq(), makeRes(), vi.fn());
    expect(h.tryIncrement).toHaveBeenCalledWith('oauth-limit:oauth-callback:203.0.113.7', 5, 120_000);
  });

  it('buckets IPv6 by /64 so rotating addresses share one budget', async () => {
    h.clientIp.mockReturnValue('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    await oauthIpRateLimit('oauth-init')(makeReq(), makeRes(), vi.fn());
    expect(h.tryIncrement).toHaveBeenCalledWith('oauth-limit:oauth-init:2001:db8:1:2::/64', 40, 600_000);
  });

  it('redirects a navigation to the login page with Retry-After when over the limit', async () => {
    h.tryIncrement.mockResolvedValue({ success: false, count: 41, expiresAt: new Date(Date.now() + 30_000) });
    const res = makeRes();
    const next = vi.fn();
    await oauthIpRateLimit('oauth-init')(makeReq(), res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 30);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?error=Too%20many/));
    expect(next).not.toHaveBeenCalled();
  });

  it('answers a JSON caller with TooManyRequestsError', async () => {
    h.tryIncrement.mockResolvedValue({ success: false, count: 41, expiresAt: new Date(Date.now() + 30_000) });
    const res = makeRes();
    const next = vi.fn();
    await oauthIpRateLimit('oauth-init')(makeReq('application/json'), res, next);
    expect(next.mock.calls[0][0]).toBeInstanceOf(TooManyRequestsError);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('bypasses the counter when E2E is enabled', async () => {
    h.e2e.mockReturnValue(true);
    const next = vi.fn();
    await oauthIpRateLimit('oauth-init')(makeReq(), makeRes(), next);
    expect(h.tryIncrement).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });
});
