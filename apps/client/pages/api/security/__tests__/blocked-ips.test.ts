import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Managing the IP blocklist is an administrative security control: every method is admin-only,
 * every change is audited with a reason, and a block takes a validated target, scope and duration.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const repo = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([{ ip: '1.2.3.4' }]),
  block: vi.fn(),
  unblock: vi.fn(),
  unblockById: vi.fn(),
}));

const audit = vi.hoisted(() => ({ record: vi.fn(), inTransaction: [] as boolean[], txActive: false }));
const clientIp = vi.hoisted(() => ({ value: '192.0.2.10' }));

vi.mock('@bike4mind/database', () => ({
  blockedIPRepository: repo,
  withTransaction: async (fn: () => Promise<unknown>) => {
    audit.txActive = true;
    try {
      return await fn();
    } finally {
      audit.txActive = false;
    }
  },
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => clientIp.value }));
vi.mock('@server/utils/adminAudit', async () => {
  const { AdminActionReasonSchema } = await import('@bike4mind/common');
  return {
    recordAdminActionFromRequest: audit.record,
    parseAdminActionReason: (value: unknown) => {
      const parsed = AdminActionReasonSchema.safeParse(value);
      if (!parsed.success) throw new Error('A reason is required');
      return parsed.data;
    },
  };
});

import { PERMANENT_IP_BLOCK_EXPIRES_AT } from '@bike4mind/common';
import '@pages/api/security/blocked-ips';

function mocks(user: unknown, extra: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'GET', ...extra });
  (req as any).user = user;
  return { req, res };
}

const ADMIN = { id: 'admin1', isAdmin: true, email: 'admin@example.com' };
const NON_ADMIN = { id: 'u1', isAdmin: false };
const REASON = 'Card testing from this network';
const BLOCK = { ip: '203.0.113.0/24', scope: 'all', duration: '7d', reason: REASON };
const UNBLOCK_ID = '64b7f0c2a1b2c3d4e5f60718';

describe('/api/security/blocked-ips', () => {
  beforeEach(() => {
    clientIp.value = '192.0.2.10';
    repo.list.mockClear();
    repo.block.mockReset().mockImplementation(async (ip: string, reason: string, options: { expiresAt: Date }) => ({
      doc: { ip, reason, expiresAt: options.expiresAt },
      created: true,
      extended: false,
    }));
    repo.unblock.mockReset().mockResolvedValue({ ip: '1.2.3.4', expiresAt: new Date(Date.now() + 3_600_000) });
    repo.unblockById
      .mockReset()
      .mockResolvedValue({ ip: '203.0.113.0/24', scope: 'all', expiresAt: new Date(Date.now() + 3_600_000) });
    audit.record.mockReset().mockImplementation(async () => {
      audit.inTransaction.push(audit.txActive);
      return null;
    });
    audit.inTransaction = [];
  });

  it.each([
    ['GET', () => mockRefs.getHandler!, () => repo.list],
    ['POST', () => mockRefs.postHandler!, () => repo.block],
    ['DELETE', () => mockRefs.deleteHandler!, () => repo.unblock],
  ])('%s rejects a non-admin without touching the repository', async (_method, getHandler, getRepoFn) => {
    const { req, res } = mocks(NON_ADMIN, { body: { ...BLOCK, ip: '1.2.3.4' }, query: { ip: '1.2.3.4' } });
    await expect(getHandler()(req, res)).rejects.toThrow(/admin/i);
    expect(getRepoFn()).not.toHaveBeenCalled();
  });

  it('GET returns the list for an admin', async () => {
    const { req, res } = mocks(ADMIN);
    await mockRefs.getHandler!(req, res);
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });

  describe('POST', () => {
    it('blocks a range with the chosen scope, duration and the admin as blocker', async () => {
      const before = Date.now();
      const { req, res } = mocks(ADMIN, { method: 'POST', body: { ...BLOCK, ip: '203.0.113.77/24' } });
      await mockRefs.postHandler!(req, res);
      expect(res._getStatusCode()).toBe(201);
      const [ip, reason, options] = repo.block.mock.calls[0];
      expect(ip).toBe('203.0.113.0/24');
      expect(reason).toBe(REASON);
      expect(options).toMatchObject({
        scope: 'all',
        source: 'manual',
        blockedBy: { id: 'admin1', name: 'admin@example.com' },
      });
      const expiresIn = options.expiresAt.getTime() - before;
      expect(expiresIn).toBeGreaterThanOrEqual(7 * 24 * 3_600_000);
      expect(expiresIn).toBeLessThan(7 * 24 * 3_600_000 + 5_000);
    });

    it('stores a permanent block with the permanent expiry', async () => {
      const { req, res } = mocks(ADMIN, { method: 'POST', body: { ...BLOCK, duration: 'permanent' } });
      await mockRefs.postHandler!(req, res);
      expect(repo.block.mock.calls[0][2].expiresAt).toEqual(PERMANENT_IP_BLOCK_EXPIRES_AT);
    });

    it('records security.blocked_ip.added inside the block transaction', async () => {
      const { req, res } = mocks(ADMIN, { method: 'POST', body: BLOCK });
      await mockRefs.postHandler!(req, res);
      expect(res._getStatusCode()).toBe(201);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][0]).toBe(req);
      expect(audit.record.mock.calls[0][1]).toMatchObject({
        action: 'security.blocked_ip.added',
        target: { kind: 'settings', id: 'blocked-ip:203.0.113.0/24', displayName: '203.0.113.0/24' },
        summary: 'blocked ip 203.0.113.0/24 (all, 7d)',
        details: { ip: '203.0.113.0/24', scope: 'all', duration: '7d', extendedExisting: false },
        reason: REASON,
      });
      expect(audit.inTransaction).toEqual([true]);
      expect(repo.block.mock.invocationCallOrder[0]).toBeLessThan(audit.record.mock.invocationCallOrder[0]);
    });

    it('audits an extension of an existing block', async () => {
      repo.block.mockResolvedValue({
        doc: { ip: '203.0.113.0/24', expiresAt: new Date() },
        created: false,
        extended: true,
      });
      const { req, res } = mocks(ADMIN, { method: 'POST', body: BLOCK });
      await mockRefs.postHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toMatchObject({ alreadyBlocked: true, extended: true });
      expect(audit.record.mock.calls[0][1]).toMatchObject({
        summary: 'extended block of ip 203.0.113.0/24 (7d)',
        details: { extendedExisting: true },
      });
    });

    it('returns an unchanged existing block without auditing it', async () => {
      repo.block.mockResolvedValue({ doc: { ip: '1.2.3.4', reason: 'earlier' }, created: false, extended: false });
      const { req, res } = mocks(ADMIN, { method: 'POST', body: { ...BLOCK, ip: '1.2.3.4' } });
      await mockRefs.postHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toMatchObject({ item: { reason: 'earlier' }, alreadyBlocked: true, extended: false });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('fails without a 201 when the audit write rejects', async () => {
      audit.record.mockRejectedValue(new Error('audit down'));
      const { req, res } = mocks(ADMIN, { method: 'POST', body: BLOCK });
      await expect(mockRefs.postHandler!(req, res)).rejects.toThrow('audit down');
      expect(res._isEndCalled()).toBe(false);
    });

    it('refuses a block that covers the admin own IP', async () => {
      clientIp.value = '203.0.113.9';
      const { req, res } = mocks(ADMIN, { method: 'POST', body: BLOCK });
      await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/your own IP/);
      expect(repo.block).not.toHaveBeenCalled();
    });

    it.each([
      ['a missing reason', { ...BLOCK, reason: undefined }],
      ['a short reason', { ...BLOCK, reason: 'abc' }],
      ['a missing duration', { ...BLOCK, duration: undefined }],
      ['an unknown duration', { ...BLOCK, duration: '90d' }],
      ['a missing scope', { ...BLOCK, scope: undefined }],
      ['an IP over 64 characters', { ...BLOCK, ip: 'x'.repeat(65) }],
      ['a malformed IP', { ...BLOCK, ip: '1.2.3.999' }],
      ['an overly broad IPv4 range', { ...BLOCK, ip: '10.0.0.0/8' }],
      ['an overly broad IPv6 range', { ...BLOCK, ip: '2001:db8::/16' }],
    ])('rejects %s', async (_label, body) => {
      const { req, res } = mocks(ADMIN, { method: 'POST', body });
      await mockRefs.postHandler!(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(repo.block).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('unblocks by id and audits the removal with its reason', async () => {
      const { req, res } = mocks(ADMIN, { method: 'DELETE', body: { id: UNBLOCK_ID, reason: REASON } });
      await mockRefs.deleteHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(repo.unblockById).toHaveBeenCalledWith(UNBLOCK_ID);
      expect(repo.unblock).not.toHaveBeenCalled();
      expect(audit.record.mock.calls[0][1]).toMatchObject({
        action: 'security.blocked_ip.removed',
        target: { kind: 'settings', id: 'blocked-ip:203.0.113.0/24' },
        details: { ip: '203.0.113.0/24', scope: 'all', wasExpired: false },
        reason: REASON,
      });
      expect(audit.inTransaction).toEqual([true]);
    });

    it('still unblocks by the legacy ?ip= form', async () => {
      const { req, res } = mocks(ADMIN, { method: 'DELETE', query: { ip: '1.2.3.4' }, body: { reason: REASON } });
      await mockRefs.deleteHandler!(req, res);
      expect(repo.unblock).toHaveBeenCalledWith('1.2.3.4');
      expect(audit.record.mock.calls[0][1]).toMatchObject({ details: { ip: '1.2.3.4', scope: 'login' } });
    });

    it('requires a reason', async () => {
      const { req, res } = mocks(ADMIN, { method: 'DELETE', body: { id: UNBLOCK_ID } });
      await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(/reason/);
      expect(repo.unblockById).not.toHaveBeenCalled();
    });

    it.each([
      ['repeated query parameters', { query: { ip: ['a', 'b'] } }],
      ['an operator object in the body', { body: { ip: { $ne: null }, reason: REASON } }],
      ['a missing IP and id', { body: { reason: REASON } }],
    ])('rejects %s', async (_label, extra) => {
      const { req, res } = mocks(ADMIN, { method: 'DELETE', ...extra });
      await mockRefs.deleteHandler!(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData()).toMatchObject({ error: 'Invalid request', details: expect.any(Array) });
      expect(repo.unblock).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('flags an unblock of an already-expired block', async () => {
      const expiresAt = new Date(Date.now() - 60_000);
      repo.unblock.mockResolvedValueOnce({ ip: '1.2.3.4', expiresAt });
      const { req, res } = mocks(ADMIN, { method: 'DELETE', query: { ip: '1.2.3.4' }, body: { reason: REASON } });
      await mockRefs.deleteHandler!(req, res);
      expect(audit.record.mock.calls[0][1].details).toEqual({
        ip: '1.2.3.4',
        scope: 'login',
        expiresAt,
        wasExpired: true,
      });
    });

    it('records nothing when there was no active block', async () => {
      repo.unblockById.mockResolvedValueOnce(null);
      const { req, res } = mocks(ADMIN, { method: 'DELETE', body: { id: UNBLOCK_ID, reason: REASON } });
      await mockRefs.deleteHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('fails without a 200 when the audit write rejects', async () => {
      audit.record.mockRejectedValue(new Error('audit down'));
      const { req, res } = mocks(ADMIN, { method: 'DELETE', body: { id: UNBLOCK_ID, reason: REASON } });
      await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('audit down');
      expect(res._isEndCalled()).toBe(false);
    });
  });
});
