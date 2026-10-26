import { describe, expect, it, vi } from 'vitest';
import { isTurnstileSecretConfigured, verifyTurnstile } from './turnstile';

const respond = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => body });
const base = { secret: 's', expectedAction: 'otc-send', ip: '203.0.113.9' };

describe('verifyTurnstile', () => {
  it('accepts a valid token and forwards the secret, token and ip', async () => {
    const fetchImpl = respond({ success: true, action: 'otc-send', hostname: 'app.example.com' });
    const result = await verifyTurnstile({ ...base, token: 'tok', fetchImpl });
    expect(result).toEqual({ ok: true });
    const params = (fetchImpl.mock.calls[0][1].body as URLSearchParams).toString();
    expect(params).toContain('secret=s');
    expect(params).toContain('response=tok');
    expect(params).toContain('remoteip=203.0.113.9');
  });

  it.each([undefined, '', 42])('treats %s as a missing token without calling siteverify', async token => {
    const fetchImpl = respond({ success: true });
    expect(await verifyTurnstile({ ...base, token, fetchImpl })).toEqual({ ok: false, reason: 'missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an invalid or duplicate token', async () => {
    const fetchImpl = respond({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    const result = await verifyTurnstile({ ...base, token: 'tok', fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects an action mismatch', async () => {
    const fetchImpl = respond({ success: true, action: 'other' });
    expect(await verifyTurnstile({ ...base, token: 'tok', fetchImpl })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects a hostname outside the allowlist and accepts one inside it', async () => {
    const body = { success: true, action: 'otc-send', hostname: 'Evil.example.net' };
    const bad = await verifyTurnstile({
      ...base,
      token: 'tok',
      fetchImpl: respond(body),
      allowedHostnames: ['app.example.com'],
    });
    expect(bad).toMatchObject({ ok: false, reason: 'invalid' });
    const good = await verifyTurnstile({
      ...base,
      token: 'tok',
      fetchImpl: respond({ ...body, hostname: 'APP.example.com' }),
      allowedHostnames: ['app.example.com'],
    });
    expect(good).toEqual({ ok: true });
  });

  it('reports unavailable on network error, timeout and non-2xx', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('network'));
    expect(await verifyTurnstile({ ...base, token: 'tok', fetchImpl: boom })).toMatchObject({ reason: 'unavailable' });
    const slow = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        })
    );
    const timed = await verifyTurnstile({
      ...base,
      token: 'tok',
      fetchImpl: slow as unknown as typeof fetch,
      timeoutMs: 10,
    });
    expect(timed).toMatchObject({ reason: 'unavailable' });
    expect(await verifyTurnstile({ ...base, token: 'tok', fetchImpl: respond({}, false) })).toMatchObject({
      reason: 'unavailable',
    });
  });
});

describe('isTurnstileSecretConfigured', () => {
  it('rejects blank and placeholder values', () => {
    expect(isTurnstileSecretConfigured(undefined)).toBe(false);
    expect(isTurnstileSecretConfigured('  ')).toBe(false);
    expect(isTurnstileSecretConfigured('not-configured')).toBe(false);
    expect(isTurnstileSecretConfigured('0x4AAA')).toBe(true);
  });
});
