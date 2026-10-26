import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const policy = vi.hoisted(() => ({
  value: { active: true, failClosed: false, siteKey: 'site', secret: 'secret' },
}));
const verify = vi.hoisted(() => vi.fn());

vi.mock('@server/utils/auth/turnstile', () => ({
  getTurnstilePolicy: async () => policy.value,
  turnstileAllowedHostnames: () => ['app.example.com'],
}));
vi.mock('@bike4mind/server-utils/utils/turnstile', () => ({ verifyTurnstile: verify }));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => '203.0.113.9' }));

import { requireTurnstile } from './requireTurnstile';

function run(body: unknown = { turnstileToken: 'tok' }) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  const logger = { warn: vi.fn() };
  const req = { body, logger, requestId: 'r1' } as unknown as Request;
  const res = { status } as unknown as Response;
  return requireTurnstile('otc-send')(req, res, next).then(() => ({ json, status, next, logger }));
}

describe('requireTurnstile', () => {
  beforeEach(() => {
    verify.mockReset();
    policy.value = { active: true, failClosed: false, siteKey: 'site', secret: 'secret' };
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
});
