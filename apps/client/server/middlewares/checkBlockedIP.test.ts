import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { parseIpRange } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  isBlocked: vi.fn(),
  listActiveAllScope: vi.fn(),
  emitMetric: vi.fn(),
  clientIp: '203.0.113.9',
}));

vi.mock('@bike4mind/database', () => ({
  blockedIPRepository: { isBlocked: h.isBlocked, listActiveAllScope: h.listActiveAllScope },
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => h.clientIp }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: h.emitMetric }));

import {
  checkBlockedIP,
  ipBlockRefusal,
  LOGIN_LOCKOUT_MESSAGE,
  NETWORK_BLOCKED_MESSAGE,
  resetIpBlockCache,
} from './checkBlockedIP';

const inAnHour = () => new Date(Date.now() + 3_600_000);
const rangeRow = (target: string, expiresAt = inAnHour()) => {
  const range = parseIpRange(target)!;
  return { ip: range.canonical, rangeStart: range.start, rangeEnd: range.end, scope: 'all', expiresAt };
};

const logger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });

async function run(
  middleware: ReturnType<typeof checkBlockedIP>,
  { method = 'POST', url = '/api/thing', accept = 'application/json', user }: Record<string, unknown> = {}
) {
  const { req, res } = createMocks({
    method: method as 'POST',
    url: url as string,
    headers: { accept: accept as string },
  });
  Object.assign(req, { logger: logger(), requestId: 'req-1', user });
  const next = vi.fn();
  await middleware(req as never, res as never, next);
  return { req, res, next };
}

describe('checkBlockedIP', () => {
  beforeEach(() => {
    resetIpBlockCache();
    h.clientIp = '203.0.113.9';
    h.isBlocked.mockReset().mockResolvedValue(null);
    h.listActiveAllScope.mockReset().mockResolvedValue([]);
    h.emitMetric.mockReset().mockResolvedValue(undefined);
  });

  describe('login surface', () => {
    it('refuses a login lockout with the lockout message and its expiry', async () => {
      const expiresAt = inAnHour();
      h.isBlocked.mockResolvedValue({ ip: '203.0.113.9', scope: 'login', expiresAt, reason: 'internal note' });
      const { res, next } = await run(checkBlockedIP());
      expect(h.isBlocked).toHaveBeenCalledWith('203.0.113.9', 'login');
      expect(next).not.toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(403);
      const body = res._getJSONData();
      expect(body).toMatchObject({ error: LOGIN_LOCKOUT_MESSAGE, blocked: true, expiresAt: expiresAt.toISOString() });
      expect(body).not.toHaveProperty('reason');
    });

    it('refuses an all block with the neutral message and no detail', async () => {
      h.isBlocked.mockResolvedValue({ ip: '203.0.113.0/24', scope: 'all', expiresAt: inAnHour() });
      const { res } = await run(checkBlockedIP());
      expect(res._getJSONData()).toEqual({ error: NETWORK_BLOCKED_MESSAGE, blocked: true, request_id: 'req-1' });
    });

    it('treats a legacy row without a scope as a login lockout', async () => {
      h.isBlocked.mockResolvedValue({ ip: '203.0.113.9', expiresAt: inAnHour() });
      const { res } = await run(checkBlockedIP());
      expect(res._getJSONData().error).toBe(LOGIN_LOCKOUT_MESSAGE);
    });

    it.each([
      ['login', 'ip_blocked'],
      ['all', 'network_blocked'],
    ])('redirects a browser navigation caught by a %s block to /login?error=%s', async (scope, code) => {
      h.isBlocked.mockResolvedValue({ ip: '203.0.113.9', scope, expiresAt: inAnHour() });
      const { res } = await run(checkBlockedIP(), {
        method: 'GET',
        url: '/api/auth/google/callback',
        accept: 'text/html',
      });
      expect(res._getStatusCode()).toBe(302);
      expect(res._getRedirectUrl()).toBe(`/login?error=${code}`);
    });

    it('lets an unblocked address through', async () => {
      const { next } = await run(checkBlockedIP());
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('app surface', () => {
    const gate = () => checkBlockedIP({ surface: 'app', writesOnly: true, exemptAdmins: true });

    it('refuses an address inside an all-scope range with the neutral 403, never a redirect', async () => {
      h.listActiveAllScope.mockResolvedValue([rangeRow('203.0.113.0/24')]);
      const { res, next } = await run(gate(), { accept: 'text/html' });
      expect(next).not.toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().error).toBe(NETWORK_BLOCKED_MESSAGE);
      expect(h.isBlocked).not.toHaveBeenCalled();
    });

    it('ignores login lockouts, which the cached list never contains', async () => {
      h.isBlocked.mockResolvedValue({ ip: '203.0.113.9', scope: 'login', expiresAt: inAnHour() });
      const { next } = await run(gate());
      expect(next).toHaveBeenCalledWith();
      expect(h.isBlocked).not.toHaveBeenCalled();
    });

    it('lets an address outside every range through', async () => {
      h.listActiveAllScope.mockResolvedValue([rangeRow('198.51.100.0/24')]);
      const { next } = await run(gate());
      expect(next).toHaveBeenCalledWith();
    });

    it('stops matching a cached block once it expires', async () => {
      h.listActiveAllScope.mockResolvedValue([rangeRow('203.0.113.0/24', new Date(Date.now() - 1))]);
      const { next } = await run(gate());
      expect(next).toHaveBeenCalledWith();
    });

    it('lets reads through when writesOnly is set', async () => {
      h.listActiveAllScope.mockResolvedValue([rangeRow('203.0.113.0/24')]);
      const { next } = await run(gate(), { method: 'GET' });
      expect(next).toHaveBeenCalledWith();
      expect(h.listActiveAllScope).not.toHaveBeenCalled();
    });

    it('lets an admin through when exemptAdmins is set', async () => {
      h.listActiveAllScope.mockResolvedValue([rangeRow('203.0.113.0/24')]);
      const { next } = await run(gate(), { user: { id: 'a1', isAdmin: true } });
      expect(next).toHaveBeenCalledWith();
    });

    it('reads the block list once per cache window', async () => {
      await run(gate());
      await run(gate());
      expect(h.listActiveAllScope).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure', () => {
    it('fails open, logs at error level and counts the failure', async () => {
      h.listActiveAllScope.mockRejectedValue(new Error('mongo down'));
      const { req, next } = await run(checkBlockedIP({ surface: 'app' }));
      expect(next).toHaveBeenCalledWith();
      expect((req as unknown as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalledWith(
        expect.stringContaining('blocked-IP check failed'),
        expect.objectContaining({ surface: 'app', error: 'mongo down' })
      );
      expect(h.emitMetric).toHaveBeenCalledWith(
        'Lumina5/Security',
        'IpBlockCheckFailed',
        1,
        { Surface: 'app' },
        'Count'
      );
    });

    it('fails open on the login surface too', async () => {
      h.isBlocked.mockRejectedValue(new Error('mongo down'));
      expect(await ipBlockRefusal({ headers: {} }, 'login')).toBeNull();
      expect(h.emitMetric).toHaveBeenCalledWith(
        'Lumina5/Security',
        'IpBlockCheckFailed',
        1,
        { Surface: 'login' },
        'Count'
      );
    });
  });
});
