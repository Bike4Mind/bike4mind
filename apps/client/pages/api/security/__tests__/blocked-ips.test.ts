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
  block: vi.fn().mockResolvedValue({ ip: '1.2.3.4' }),
  unblock: vi.fn().mockResolvedValue({ ip: '1.2.3.4' }),
}));

vi.mock('@bike4mind/database', () => ({ blockedIPRepository: repo }));

import '@pages/api/security/blocked-ips';

function mocks(user: unknown, extra: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'GET', ...extra });
  (req as any).user = user;
  return { req, res };
}

const ADMIN = { id: 'admin1', isAdmin: true };
const NON_ADMIN = { id: 'u1', isAdmin: false };

describe('/api/security/blocked-ips — admin gate', () => {
  beforeEach(() => {
    repo.list.mockClear();
    repo.block.mockClear();
    repo.unblock.mockClear();
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
});
