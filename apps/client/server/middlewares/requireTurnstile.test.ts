import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

const policy = vi.hoisted(() => ({
  value: { active: true, failClosed: false, siteKey: 'site', secret: 'secret' },
}));
const verify = vi.hoisted(() => vi.fn());
const getPolicy = vi.hoisted(() => vi.fn());
const e2eEnabled = vi.hoisted(() => ({ value: false }));
const e2eSecret = vi.hoisted(() => ({ value: 'e2e-secret' as string | undefined }));
const production = vi.hoisted(() => ({ value: false }));
const development = vi.hoisted(() => ({ value: true }));
const TEST_SECRET = '1x0000000000000000000000000000000AA';

vi.mock('@server/utils/auth/turnstile', () => ({
  getTurnstilePolicy: getPolicy,
  turnstileAllowedHostnames: () => ['app.example.com'],
}));
vi.mock('@bike4mind/server-utils/utils/turnstile', () => ({
  verifyTurnstile: verify,
  isTurnstileTestSecret: (secret: string) => secret === TEST_SECRET,
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  isE2EEnabled: () => e2eEnabled.value,
  isProduction: () => production.value,
  isDevelopment: () => development.value,
}));
vi.mock('sst', () => ({ Resource: { E2E_CLEANUP_SECRET: e2eSecret } }));

import { requireTurnstile } from './requireTurnstile';

async function run(body: unknown = { turnstileToken: 'tok' }, headers: Record<string, string> = {}) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const req = { body, headers, logger, requestId: 'r1' } as unknown as Request;
  const res = { status } as unknown as Response;
  await requireTurnstile('otc-send')(req, res, next);
  return { json, status, next, logger };
}

describe('requireTurnstile', () => {
  beforeEach(() => {
    verify.mockReset();
    getPolicy.mockReset();
    getPolicy.mockImplementation(async () => policy.value);
    policy.value = { active: true, failClosed: false, siteKey: 'site', secret: 'secret' };
    e2eEnabled.value = false;
    e2eSecret.value = 'e2e-secret';
    production.value = false;
    development.value = true;
    vi.stubEnv('E2E_CLEANUP_SECRET', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('refuses and logs an unreadable policy instead of bypassing verification', async () => {
    getPolicy.mockRejectedValue(new Error('database unavailable'));
    const { next, status, json, logger } = await run();
    expect(next).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'challenge_unavailable' }));
    expect(logger.warn).toHaveBeenCalledWith('turnstile-policy-unreadable', expect.any(Error));
  });

  it('skips verification when the feature is not active', async () => {
    policy.value = { ...policy.value, active: false };
    const { next } = await run({});
    expect(next).toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('passes a verified token and sends the ip, action and hostnames to verification', async () => {
    verify.mockResolvedValue({ ok: true });
    const { next } = await run();
    expect(next).toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'tok',
        ip: '203.0.113.9',
        expectedAction: 'otc-send',
        allowedHostnames: ['app.example.com'],
      })
    );
  });

  it.each(['missing', 'invalid'])('returns 403 challenge_failed for a %s token and never logs it', async reason => {
    verify.mockResolvedValue({ ok: false, reason });
    const { next, status, json, logger } = await run();
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'challenge_failed' }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('tok"');
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('203.0.113.9');
  });

  it('fails open on an outage by default', async () => {
    verify.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const { next, status } = await run();
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('fails closed on an outage when configured', async () => {
    policy.value = { ...policy.value, failClosed: true };
    verify.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const { next, status } = await run();
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  describe('Cloudflare test secrets', () => {
    it('allows a test secret in local development without logging', async () => {
      policy.value = { ...policy.value, secret: TEST_SECRET };
      verify.mockResolvedValue({ ok: true });
      const { next, logger } = await run();
      expect(next).toHaveBeenCalled();
      expect(verify).toHaveBeenCalledWith(expect.objectContaining({ allowTestSecret: true }));
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('allows a test secret on a deployed non-production stage but warns', async () => {
      development.value = false;
      policy.value = { ...policy.value, secret: TEST_SECRET };
      verify.mockResolvedValue({ ok: true });
      const { next, logger } = await run();
      expect(next).toHaveBeenCalled();
      expect(verify).toHaveBeenCalledWith(expect.objectContaining({ allowTestSecret: true }));
      expect(logger.warn).toHaveBeenCalledWith('turnstile-test-secret-on-deployed-stage', { action: 'otc-send' });
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not warn for a real secret on a deployed non-production stage', async () => {
      development.value = false;
      verify.mockResolvedValue({ ok: true });
      const { logger } = await run();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('keeps the strict checks on production and logs a test secret as an error', async () => {
      production.value = true;
      policy.value = { ...policy.value, secret: TEST_SECRET };
      verify.mockResolvedValue({ ok: false, reason: 'invalid', errorCodes: ['action-mismatch'] });
      const { next, status, logger } = await run();
      expect(verify).toHaveBeenCalledWith(expect.objectContaining({ allowTestSecret: false }));
      expect(logger.error).toHaveBeenCalledWith('turnstile-test-secret-in-production', { action: 'otc-send' });
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(403);
    });

    it('does not log an error for a real secret on production', async () => {
      production.value = true;
      verify.mockResolvedValue({ ok: true });
      const { logger } = await run();
      expect(verify).toHaveBeenCalledWith(expect.objectContaining({ allowTestSecret: false }));
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('options', () => {
    it('reads the token from a custom location', async () => {
      verify.mockResolvedValue({ ok: true });
      const next = vi.fn();
      const req = {
        query: { turnstileToken: 'from-query' },
        headers: {},
        logger: { warn: vi.fn() },
      } as unknown as Request;
      await requireTurnstile('oauth-start', { token: r => r.query?.turnstileToken })(req, {} as Response, next);
      expect(next).toHaveBeenCalled();
      expect(verify).toHaveBeenCalledWith(expect.objectContaining({ token: 'from-query' }));
    });

    it('skips an exempt request before reading the policy', async () => {
      const next = vi.fn();
      const req = { body: {}, headers: {} } as unknown as Request;
      await requireTurnstile('otc-send', { exempt: () => true })(req, {} as Response, next);
      expect(next).toHaveBeenCalled();
      expect(getPolicy).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    });

    it('hands a failure to the custom handler instead of answering JSON', async () => {
      verify.mockResolvedValue({ ok: false, reason: 'invalid' });
      const onFailure = vi.fn();
      const next = vi.fn();
      const status = vi.fn();
      const req = { body: { turnstileToken: 'tok' }, headers: {}, logger: { warn: vi.fn() } } as unknown as Request;
      const res = { status } as unknown as Response;
      await requireTurnstile('otc-send', { onFailure })(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith(
        req,
        res,
        expect.objectContaining({ code: 'challenge_failed', status: 403 })
      );
    });

    it('hands an unreadable policy to the custom handler as unavailable', async () => {
      getPolicy.mockRejectedValue(new Error('database unavailable'));
      const onFailure = vi.fn();
      const next = vi.fn();
      const req = { body: { turnstileToken: 'tok' }, headers: {}, logger: { warn: vi.fn() } } as unknown as Request;
      await requireTurnstile('otc-send', { onFailure })(req, {} as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith(
        req,
        expect.anything(),
        expect.objectContaining({ code: 'challenge_unavailable', status: 503 })
      );
    });
  });

  describe('e2e bypass', () => {
    const e2eBody = { email: 'Login-123-E2E@test.com' };
    const e2eHeaders = { 'x-e2e-cleanup-secret': 'e2e-secret' };

    it('skips verification for a test account carrying the E2E secret on a non-production stage', async () => {
      e2eEnabled.value = true;
      const { next } = await run(e2eBody, e2eHeaders);
      expect(next).toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    });

    it.each([
      ['production stage', false, e2eBody, e2eHeaders],
      ['wrong secret', true, e2eBody, { 'x-e2e-cleanup-secret': 'nope' }],
      ['missing secret', true, e2eBody, {}],
      ['real email', true, { email: 'someone@example.com' }, e2eHeaders],
      ['missing email', true, {}, e2eHeaders],
      ['non-string email', true, { email: ['login-e2e@test.com'] }, e2eHeaders],
      ['lookalike email', true, { email: 'login-e2e@test.com.evil.example' }, e2eHeaders],
    ])('still verifies the token on a %s', async (_label, enabled, body, headers) => {
      e2eEnabled.value = enabled;
      verify.mockResolvedValue({ ok: false, reason: 'missing' });
      const { next, status } = await run(body, headers);
      expect(next).not.toHaveBeenCalled();
      expect(verify).toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(403);
    });

    it.each([undefined, '', 'not-configured'])('still verifies with an unconfigured E2E secret (%s)', async secret => {
      e2eEnabled.value = true;
      e2eSecret.value = secret;
      verify.mockResolvedValue({ ok: false, reason: 'missing' });
      const { next, status } = await run(e2eBody, { 'x-e2e-cleanup-secret': secret ?? '' });
      expect(next).not.toHaveBeenCalled();
      expect(verify).toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(403);
    });

    it('accepts the environment secret when no resource secret is provisioned', async () => {
      e2eEnabled.value = true;
      e2eSecret.value = undefined;
      vi.stubEnv('E2E_CLEANUP_SECRET', 'environment-secret');
      const { next } = await run(e2eBody, { 'x-e2e-cleanup-secret': 'environment-secret' });
      expect(next).toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    });
  });
});
