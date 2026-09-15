import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * blocked-ips/evaluate writes to the IP blocklist (auto-blocking high-attempt
 * IPs), so like the rest of that control it must be admin-only. Prove a
 * non-admin is rejected before any evaluation or write runs.
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const authFail = vi.hoisted(() => ({ getIPsWithHighAttempts: vi.fn().mockResolvedValue([]) }));
const blockedIP = vi.hoisted(() => ({ block: vi.fn().mockResolvedValue({}) }));
vi.mock('@bike4mind/database', () => ({
  authFailLogRepository: authFail,
  blockedIPRepository: blockedIP,
}));

import '@pages/api/security/blocked-ips/evaluate';

function mocks(user: unknown) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).user = user;
  return { req, res };
}

describe('POST /api/security/blocked-ips/evaluate - admin gate', () => {
  beforeEach(() => {
    authFail.getIPsWithHighAttempts.mockClear();
    blockedIP.block.mockClear();
  });

  it('rejects a non-admin before evaluating', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/admin/i);
    expect(authFail.getIPsWithHighAttempts).not.toHaveBeenCalled();
  });

  it('runs the evaluation for an admin', async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true });
    await mockRefs.postHandler!(req, res);
    expect(authFail.getIPsWithHighAttempts).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });
});
