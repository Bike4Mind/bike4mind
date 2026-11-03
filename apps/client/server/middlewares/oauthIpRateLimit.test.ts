import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TooManyRequestsError } from '@bike4mind/utils';
import type { Request, Response } from 'express';

const h = vi.hoisted(() => ({
  tryIncrement: vi.fn(),
  clientIp: vi.fn(),
  e2e: vi.fn(),
  e2eSecret: vi.fn(),
  getSettingsMap: vi.fn(),
  settings: {} as Record<string, string>,
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrement },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: h.getSettingsMap,
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: h.clientIp }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isE2EEnabled: h.e2e }));
vi.mock('@server/auth/e2eTestSecret', () => ({ isValidE2eTestSecret: h.e2eSecret }));

import { oauthIpRateLimit } from './oauthIpRateLimit';

const makeReq = (accept = 'text/html', url = '/api/auth/google') =>
  ({ url, headers: { accept }, logger: { warn: vi.fn() } }) as unknown as Request & {
    logger: { warn: ReturnType<typeof vi.fn> };
  };
const makeRes = () =>
  ({ setHeader: vi.fn(), redirect: vi.fn() }) as unknown as Response & {
    setHeader: ReturnType<typeof vi.fn>;
    redirect: ReturnType<typeof vi.fn>;
  };

describe('oauthIpRateLimit', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.settings = {};
    h.getSettingsMap.mockImplementation(async () => h.settings);
    h.clientIp.mockReturnValue('203.0.113.7');
    h.e2e.mockReturnValue(false);
    h.e2eSecret.mockReturnValue(false);
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
    const req = makeReq();
    await oauthIpRateLimit('oauth-init')(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 30);
    expect(res.redirect).toHaveBeenCalledWith('/login?error=oauth_rate_limited');
    expect(req.logger.warn).toHaveBeenCalledWith('oauth-ip-rate-limited', { bucket: 'oauth-init' });
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

  it('bypasses the counter only when E2E is enabled and the secret header is valid', async () => {
    h.e2e.mockReturnValue(true);
    h.e2eSecret.mockReturnValue(true);
    const next = vi.fn();
    await oauthIpRateLimit('oauth-init')(makeReq(), makeRes(), next);
    expect(h.tryIncrement).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it.each([
    ['E2E stage, no valid secret', true, false],
    ['valid secret on a non-E2E stage', false, true],
  ])('still counts and limits: %s', async (_name, e2e, secret) => {
    h.e2e.mockReturnValue(e2e);
    h.e2eSecret.mockReturnValue(secret);
    h.tryIncrement.mockResolvedValue({ success: false, count: 41, expiresAt: new Date(Date.now() + 30_000) });
    const res = makeRes();
    const next = vi.fn();
    await oauthIpRateLimit('oauth-init')(makeReq(), res, next);
    expect(h.tryIncrement).toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/login?error=oauth_rate_limited');
    expect(next).not.toHaveBeenCalled();
  });

  it('fails open with a warning when the counter throws', async () => {
    h.tryIncrement.mockRejectedValue(new Error('cache down'));
    const req = makeReq();
    const next = vi.fn();
    await oauthIpRateLimit('oauth-init')(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.logger.warn).toHaveBeenCalledWith(expect.stringContaining('OAuth rate limit'), expect.any(Error));
  });

  it('fails open with a warning when settings cannot be read', async () => {
    const error = new Error('settings unavailable');
    h.getSettingsMap.mockRejectedValueOnce(error);
    const req = makeReq();
    const next = vi.fn();
    await oauthIpRateLimit('oauth-init')(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(next).toHaveBeenCalledTimes(1);
    expect(h.tryIncrement).not.toHaveBeenCalled();
    expect(req.logger.warn).toHaveBeenCalledWith(expect.stringContaining('OAuth rate limit'), error);
  });
});
