import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { mockRoute, tavernUser, type RouteHandler } from './testUtils';

const refs = vi.hoisted(() => ({
  post: null as null | RouteHandler,
  create: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    post: (fn: RouteHandler) => {
      refs.post = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => () => undefined }));
vi.mock('@bike4mind/database', () => ({ ccBridgePairingTokenRepository: { create: refs.create } }));

import '../pair';

const call = (opts: Parameters<typeof mockRoute>[0]) => {
  const { req, res } = mockRoute(opts);
  return { res, run: () => refs.post!(req, res) };
};

describe('POST /api/cc-bridge/pair', () => {
  beforeEach(() => {
    refs.create.mockReset().mockResolvedValue({});
    process.env.CC_BRIDGE_PUBLIC_URL = 'https://bridge.example.test';
  });
  afterEach(() => {
    delete process.env.CC_BRIDGE_PUBLIC_URL;
    delete process.env.APP_URL;
  });

  it('rejects a request with no authenticated user and mints nothing', async () => {
    const { run } = call({ user: null, body: {} });
    await expect(run()).rejects.toThrow(/authenticated user/i);
    expect(refs.create).not.toHaveBeenCalled();
  });

  it('rejects a user without tavern access', async () => {
    const { run } = call({ user: { id: 'user-2', isAdmin: false, tags: [] }, body: {} });
    await expect(run()).rejects.toThrow(/tavern access/i);
    expect(refs.create).not.toHaveBeenCalled();
  });

  it('mints a token stored only as a bcrypt hash, bound to the caller, expiring in about 5 minutes', async () => {
    const { res, run } = call({ user: tavernUser, body: { deviceLabel: 'my laptop', platform: 'darwin-arm64' } });
    const before = Date.now();
    await run();

    expect(res._getStatusCode()).toBe(201);
    const body = res._getJSONData();
    expect(body.pairingToken).toMatch(/^b4mpair_[0-9a-f]{32}$/);
    expect(body.deviceLabel).toBe('my laptop');
    expect(body.baseUrl).toBe('https://bridge.example.test');

    const stored = refs.create.mock.calls[0][0];
    expect(stored.userId).toBe('user-1');
    expect(stored.tokenHash).not.toContain(body.pairingToken);
    expect(await bcrypt.compare(body.pairingToken, stored.tokenHash)).toBe(true);
    expect(stored.tokenPrefix).toBe(body.pairingToken.substring(0, 16));
    const ttl = stored.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000 + 5_000);
  });

  it('mints a distinct token on every call', async () => {
    const a = call({ user: tavernUser, body: {} });
    const b = call({ user: tavernUser, body: {} });
    await a.run();
    await b.run();
    expect(a.res._getJSONData().pairingToken).not.toBe(b.res._getJSONData().pairingToken);
  });

  it('generates a default device label when none is supplied', async () => {
    const { res, run } = call({ user: tavernUser, body: {} });
    await run();
    expect(res._getJSONData().deviceLabel).toMatch(/^cc-bridge-[0-9a-f]{6}$/);
  });

  it('ignores a client-supplied userId and a spoofed Host header when building the response', async () => {
    const { res, run } = call({
      user: tavernUser,
      body: { userId: 'someone-else' },
      headers: { host: 'evil.example.test', 'x-forwarded-host': 'evil.example.test' },
    });
    await run();
    expect(refs.create.mock.calls[0][0].userId).toBe('user-1');
    expect(res._getJSONData().baseUrl).toBe('https://bridge.example.test');
  });

  it('falls back to APP_URL, and returns 500 when no public URL is configured', async () => {
    delete process.env.CC_BRIDGE_PUBLIC_URL;
    process.env.APP_URL = 'https://app.example.test';
    const ok = call({ user: tavernUser, body: {} });
    await ok.run();
    expect(ok.res._getJSONData().baseUrl).toBe('https://app.example.test');

    delete process.env.APP_URL;
    const bad = call({ user: tavernUser, body: {} });
    await bad.run();
    expect(bad.res._getStatusCode()).toBe(500);
    expect(bad.res._getJSONData().pairingToken).toBeUndefined();
  });

  it.each([
    ['an empty label', { deviceLabel: '' }],
    ['an oversized label', { deviceLabel: 'a'.repeat(101) }],
    ['a label with HTML', { deviceLabel: '<script>alert(1)</script>' }],
    ['an oversized platform', { platform: 'p'.repeat(51) }],
    ['a non-string label', { deviceLabel: 42 }],
  ])('rejects %s with 400 and mints nothing', async (_name, body) => {
    const { res, run } = call({ user: tavernUser, body });
    await run();
    expect(res._getStatusCode()).toBe(400);
    expect(refs.create).not.toHaveBeenCalled();
  });

  it('rejects a label containing a newline or tab', async () => {
    const { res, run } = call({ user: tavernUser, body: { deviceLabel: 'ok\nnext\tlabel' } });
    await run();
    expect(res._getStatusCode()).toBe(400);
    expect(refs.create).not.toHaveBeenCalled();
  });
});
