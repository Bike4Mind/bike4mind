import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const policy = vi.hoisted(() => ({
  value: { active: true, failClosed: false, siteKey: 'site', secret: 'secret' },
}));
const verify = vi.hoisted(() => vi.fn());
const getPolicy = vi.hoisted(() => vi.fn());

vi.mock('@server/utils/auth/turnstile', () => ({
  getTurnstilePolicy: getPolicy,
  turnstileAllowedHostnames: () => ['app.example.com'],
}));
vi.mock('@bike4mind/server-utils/utils/turnstile', () => ({
  verifyTurnstile: verify,
  isTurnstileTestSecret: () => false,
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  isE2EEnabled: () => false,
  isProduction: () => false,
  isDevelopment: () => true,
}));
vi.mock('sst', () => ({ Resource: {} }));

import { requireOAuthStartTurnstile } from './oauthStartTurnstile';

async function start(query: Record<string, unknown>) {
  const redirect = vi.fn();
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  const logger = { warn: vi.fn() };
  const req = { query, body: undefined, headers: {}, logger, requestId: 'r1' } as unknown as Request;
  const res = { redirect, status } as unknown as Response;
  await requireOAuthStartTurnstile()(req, res, next);
  return { redirect, status, json, next, logger };
}

describe('requireOAuthStartTurnstile', () => {
  beforeEach(() => {
    verify.mockReset();
    getPolicy.mockReset();
    getPolicy.mockImplementation(async () => policy.value);
    policy.value = { active: true, failClosed: false, siteKey: 'site', secret: 'secret' };
  });

  it('lets every provider through untouched while the policy is off', async () => {
    policy.value = { ...policy.value, active: false };
    for (const strategy of ['google', 'github', 'facebook', 'okta']) {
      const { next, redirect } = await start({ strategy });
      expect(next).toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(['okta', 'saml', undefined, ['google']])(
    'never challenges enterprise or unknown strategy %j',
    async strategy => {
      const { next } = await start({ strategy });
      expect(next).toHaveBeenCalled();
      expect(getPolicy).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    }
  );

  it.each(['google', 'github', 'facebook'])(
    'verifies the query token for %s with the oauth-start action',
    async strategy => {
      verify.mockResolvedValue({ ok: true });
      const { next, redirect } = await start({ strategy, turnstileToken: 'tok' });
      expect(next).toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'tok',
          ip: '203.0.113.9',
          expectedAction: 'oauth-start',
          allowedHostnames: ['app.example.com'],
        })
      );
    }
  );

  it('sends a missing token back to the login page without starting the provider redirect', async () => {
    verify.mockResolvedValue({ ok: false, reason: 'missing' });
    const { next, redirect, status } = await start({ strategy: 'google' });
    expect(next).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith('/login?error=challenge_failed');
  });

  it('sends an invalid token back to the login page and never logs it', async () => {
    verify.mockResolvedValue({ ok: false, reason: 'invalid', errorCodes: ['timeout-or-duplicate'] });
    const { next, redirect, logger } = await start({ strategy: 'github', turnstileToken: 'tok' });
    expect(next).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith('/login?error=challenge_failed');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('tok"');
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('oauth-start');
  });

  it('fails open on a verification outage by default', async () => {
    verify.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const { next, redirect } = await start({ strategy: 'google', turnstileToken: 'tok' });
    expect(next).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('fails closed on a verification outage when configured', async () => {
    policy.value = { ...policy.value, failClosed: true };
    verify.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const { next, redirect } = await start({ strategy: 'google', turnstileToken: 'tok' });
    expect(next).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith('/login?error=challenge_failed');
  });

  it('refuses an unreadable policy with the unavailable code instead of bypassing', async () => {
    getPolicy.mockRejectedValue(new Error('database unavailable'));
    const { next, redirect } = await start({ strategy: 'google', turnstileToken: 'tok' });
    expect(next).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith('/login?error=challenge_unavailable');
  });
});
