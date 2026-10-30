import { describe, expect, it, vi } from 'vitest';
import { isTurnstileSecretConfigured, isTurnstileTestSecret, verifyTurnstile } from './turnstile';

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

  it.each([
    null,
    [],
    {},
    { success: 'true' },
    { success: false, 'error-codes': 'internal-error' },
    { success: true, hostname: 42 },
  ])('reports malformed siteverify responses as unavailable: %j', async body => {
    expect(await verifyTurnstile({ ...base, token: 'tok', fetchImpl: respond(body) })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it.each(['missing-input-secret', 'invalid-input-secret', 'bad-request'])(
    'reports a rejected secret or request as misconfigured: %s',
    async code => {
      const fetchImpl = respond({ success: false, 'error-codes': [code] });
      expect(await verifyTurnstile({ ...base, token: 'tok', fetchImpl })).toEqual({
        ok: false,
        reason: 'misconfigured',
        errorCodes: [code],
      });
    }
  );

  it('keeps misconfigured when a configuration code is mixed with other codes', async () => {
    const codes = ['invalid-input-response', 'invalid-input-secret'];
    const fetchImpl = respond({ success: false, 'error-codes': codes });
    expect(await verifyTurnstile({ ...base, token: 'tok', fetchImpl })).toEqual({
      ok: false,
      reason: 'misconfigured',
      errorCodes: codes,
    });
  });

  it('reports a Cloudflare internal-error as unavailable', async () => {
    const fetchImpl = respond({ success: false, 'error-codes': ['internal-error'] });
    expect(await verifyTurnstile({ ...base, token: 'tok', fetchImpl })).toEqual({
      ok: false,
      reason: 'unavailable',
      errorCodes: ['internal-error'],
    });
  });

  it('rejects oversized tokens without contacting the provider', async () => {
    const fetchImpl = respond({ success: true });
    expect(await verifyTurnstile({ ...base, token: 'x'.repeat(2049), fetchImpl })).toEqual({
      ok: false,
      reason: 'invalid',
    });
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

  describe('requireAllowedHostnames', () => {
    const body = { success: true, action: 'otc-send', hostname: 'app.example.com' };

    it('reports misconfigured without contacting the provider when the allowlist is empty', async () => {
      const fetchImpl = respond(body);
      const result = await verifyTurnstile({
        ...base,
        token: 'tok',
        fetchImpl,
        allowedHostnames: [],
        requireAllowedHostnames: true,
      });
      expect(result).toEqual({ ok: false, reason: 'misconfigured', errorCodes: ['hostname-allowlist-empty'] });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('behaves normally when the allowlist is not empty', async () => {
      const result = await verifyTurnstile({
        ...base,
        token: 'tok',
        fetchImpl: respond(body),
        allowedHostnames: ['app.example.com'],
        requireAllowedHostnames: true,
      });
      expect(result).toEqual({ ok: true });
    });

    it.each([false, undefined])('skips the hostname check on an empty allowlist when %s', async required => {
      const result = await verifyTurnstile({
        ...base,
        token: 'tok',
        fetchImpl: respond(body),
        requireAllowedHostnames: required,
      });
      expect(result).toEqual({ ok: true });
    });
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

describe('verifyTurnstile with a Cloudflare test secret', () => {
  const PASS_SECRET = '1x0000000000000000000000000000000AA';
  const testBase = { ...base, secret: PASS_SECRET, token: 'XXXX.DUMMY.TOKEN.XXXX', allowTestSecret: true };

  it.each([
    ['no action or hostname', { success: true }],
    ['the test action and host', { success: true, action: 'test', hostname: 'localhost' }],
  ])('accepts a passing answer with %s', async (_label, body) => {
    const result = await verifyTurnstile({
      ...testBase,
      fetchImpl: respond(body),
      allowedHostnames: ['app.example.com'],
    });
    expect(result).toEqual({ ok: true });
  });

  it('still rejects a failed answer', async () => {
    const fetchImpl = respond({ success: false, 'error-codes': ['invalid-input-response'] });
    expect(await verifyTurnstile({ ...testBase, fetchImpl })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('keeps the action and hostname checks when test secrets are not allowed', async () => {
    const fetchImpl = respond({ success: true, action: 'test', hostname: 'localhost' });
    expect(await verifyTurnstile({ ...testBase, allowTestSecret: false, fetchImpl })).toEqual({
      ok: false,
      reason: 'invalid',
      errorCodes: ['action-mismatch'],
    });
  });

  it('keeps the strict checks when allowTestSecret is omitted', async () => {
    const { allowTestSecret: _omitted, ...strict } = testBase;
    const fetchImpl = respond({ success: true, action: 'test', hostname: 'localhost' });
    expect(await verifyTurnstile({ ...strict, fetchImpl })).toMatchObject({ errorCodes: ['action-mismatch'] });
  });

  it('keeps the action and hostname checks for a real secret even when test secrets are allowed', async () => {
    const real = { ...base, token: 'tok', allowTestSecret: true };
    expect(await verifyTurnstile({ ...real, fetchImpl: respond({ success: true }) })).toMatchObject({
      errorCodes: ['action-mismatch'],
    });
    const wrongHost = respond({ success: true, action: 'otc-send', hostname: 'localhost' });
    expect(
      await verifyTurnstile({ ...real, fetchImpl: wrongHost, allowedHostnames: ['app.example.com'] })
    ).toMatchObject({ errorCodes: ['hostname-mismatch'] });
  });
});

const TEST_SECRETS = [
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
];

describe('isTurnstileTestSecret', () => {
  it('matches each published test secret exactly, ignoring surrounding whitespace', () => {
    for (const secret of TEST_SECRETS) expect(isTurnstileTestSecret(` ${secret} `)).toBe(true);
  });

  it.each([
    '',
    '0x4AAA',
    '1x0000000000000000000000000000000AAA',
    '0x0000000000000000000000000000000AA',
    '1x0000000000000000000000000000000aa',
  ])('rejects %s', secret => {
    expect(isTurnstileTestSecret(secret)).toBe(false);
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
