import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Managing the IP blocklist is an administrative security control, so every
 * method must be admin-only. These tests prove the gate holds at the HTTP
 * boundary and that the repository is never touched for a non-admin caller.
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
  block: vi.fn().mockResolvedValue({ doc: { ip: '1.2.3.4' }, created: true }),
  unblock: vi.fn().mockResolvedValue({ ip: '1.2.3.4', expiresAt: new Date(Date.now() + 3_600_000) }),
}));

const audit = vi.hoisted(() => ({ record: vi.fn(), inTransaction: [] as boolean[], txActive: false }));

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
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: audit.record }));

import '@pages/api/security/blocked-ips';

function mocks(user: unknown, extra: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'GET', ...extra });
  (req as any).user = user;
  return { req, res };
}

const ADMIN = { id: 'admin1', isAdmin: true };
const NON_ADMIN = { id: 'u1', isAdmin: false };

describe('/api/security/blocked-ips - admin gate', () => {
  beforeEach(() => {
    repo.list.mockClear();
    repo.block.mockReset().mockResolvedValue({ doc: { ip: '1.2.3.4' }, created: true });
    repo.unblock.mockClear();
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
    const { req, res } = mocks(NON_ADMIN, { body: { ip: '1.2.3.4' }, query: { ip: '1.2.3.4' } });
    await expect(getHandler()(req, res)).rejects.toThrow(/admin/i);
    expect(getRepoFn()).not.toHaveBeenCalled();
  });

  it('GET returns the list for an admin', async () => {
    const { req, res } = mocks(ADMIN);
    await mockRefs.getHandler!(req, res);
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });

  it('POST blocks an IP for an admin', async () => {
    const { req, res } = mocks(ADMIN, { method: 'POST', body: { ip: '1.2.3.4', reason: 'abuse' } });
    await mockRefs.postHandler!(req, res);
    expect(repo.block).toHaveBeenCalledWith('1.2.3.4', 'abuse');
  });

  it('DELETE unblocks an IP for an admin', async () => {
    const { req, res } = mocks(ADMIN, { method: 'DELETE', query: { ip: '1.2.3.4' } });
    await mockRefs.deleteHandler!(req, res);
    expect(repo.unblock).toHaveBeenCalledWith('1.2.3.4');
  });

  it('POST records security.blocked_ip.added inside the block transaction', async () => {
    const { req, res } = mocks(ADMIN, { method: 'POST', body: { ip: '1.2.3.4', reason: 'abuse' } });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toBe(req);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'security.blocked_ip.added',
      target: { kind: 'settings', id: 'blocked-ip:1.2.3.4', displayName: '1.2.3.4' },
      details: { ip: '1.2.3.4' },
      reason: 'abuse',
    });
    expect(audit.inTransaction).toEqual([true]);
    expect(repo.block.mock.invocationCallOrder[0]).toBeLessThan(audit.record.mock.invocationCallOrder[0]);
  });

  it('POST fails without a 201 when the audit write rejects', async () => {
    audit.record.mockRejectedValue(new Error('audit down'));
    const { req, res } = mocks(ADMIN, { method: 'POST', body: { ip: '1.2.3.4' } });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow('audit down');
    expect(res._isEndCalled()).toBe(false);
  });

  it('POST returns an existing active block without auditing it', async () => {
    repo.block.mockResolvedValue({ doc: { ip: '1.2.3.4', reason: 'earlier' }, created: false });
    const { req, res } = mocks(ADMIN, { method: 'POST', body: { ip: '1.2.3.4', reason: 'abuse' } });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ item: { reason: 'earlier' }, alreadyBlocked: true });
    expect(repo.block).toHaveBeenCalledWith('1.2.3.4', 'abuse');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('POST rejects a reason over 1000 characters', async () => {
    const { req, res } = mocks(ADMIN, { method: 'POST', body: { ip: '1.2.3.4', reason: 'x'.repeat(1001) } });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(repo.block).not.toHaveBeenCalled();
  });

  it('POST rejects an IP over 64 characters', async () => {
    const { req, res } = mocks(ADMIN, { method: 'POST', body: { ip: 'x'.repeat(65) } });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(repo.block).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['repeated query parameters', { query: { ip: ['a', 'b'] } }],
    ['an operator object in the body', { body: { ip: { $ne: null } } }],
    ['a missing IP', {}],
  ])('DELETE rejects %s', async (_label, extra) => {
    const { req, res } = mocks(ADMIN, { method: 'DELETE', ...extra });
    await mockRefs.deleteHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ error: 'Invalid request', details: expect.any(Array) });
    expect(repo.unblock).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('DELETE builds the audit entry from the removed document IP', async () => {
    repo.unblock.mockResolvedValueOnce({ ip: '5.6.7.8', expiresAt: new Date(Date.now() + 3_600_000) });
    const { req, res } = mocks(ADMIN, { method: 'DELETE', query: { ip: '1.2.3.4' } });
    await mockRefs.deleteHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(repo.unblock).toHaveBeenCalledWith('1.2.3.4');
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      target: { kind: 'settings', id: 'blocked-ip:5.6.7.8', displayName: '5.6.7.8' },
      summary: 'unblocked ip 5.6.7.8',
      details: { ip: '5.6.7.8' },
    });
  });

  it('DELETE records security.blocked_ip.removed inside the unblock transaction', async () => {
    const { req, res } = mocks(ADMIN, { method: 'DELETE', query: { ip: '1.2.3.4' } });
    await mockRefs.deleteHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'security.blocked_ip.removed',
      target: { kind: 'settings', id: 'blocked-ip:1.2.3.4' },
      details: { ip: '1.2.3.4', wasExpired: false },
    });
    expect(audit.inTransaction).toEqual([true]);
  });

  it('DELETE flags an unblock of an already-expired block', async () => {
    const expiresAt = new Date(Date.now() - 60_000);
    repo.unblock.mockResolvedValueOnce({ ip: '1.2.3.4', expiresAt });
    const { req, res } = mocks(ADMIN, { method: 'DELETE', query: { ip: '1.2.3.4' } });
    await mockRefs.deleteHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(audit.record.mock.calls[0][1].details).toEqual({ ip: '1.2.3.4', expiresAt, wasExpired: true });
  });

  it('DELETE records nothing when the IP had no active block', async () => {
    repo.unblock.mockResolvedValueOnce(null);
    const { req, res } = mocks(ADMIN, { method: 'DELETE', query: { ip: '9.9.9.9' } });
    await mockRefs.deleteHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('DELETE fails without a 200 when the audit write rejects', async () => {
    audit.record.mockRejectedValue(new Error('audit down'));
    const { req, res } = mocks(ADMIN, { method: 'DELETE', query: { ip: '1.2.3.4' } });
    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('audit down');
    expect(res._isEndCalled()).toBe(false);
  });
});
