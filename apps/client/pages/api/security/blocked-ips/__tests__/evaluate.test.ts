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
const audit = vi.hoisted(() => ({ record: vi.fn(), inTransaction: [] as boolean[], txActive: false }));
vi.mock('@bike4mind/database', () => ({
  authFailLogRepository: authFail,
  blockedIPRepository: blockedIP,
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

import '@pages/api/security/blocked-ips/evaluate';

function mocks(user: unknown) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).user = user;
  Object.assign(req, { logger: { warn: vi.fn() } });
  return { req, res };
}

const ADMIN = { id: 'admin1', isAdmin: true };

describe('POST /api/security/blocked-ips/evaluate - admin gate', () => {
  beforeEach(() => {
    authFail.getIPsWithHighAttempts.mockClear();
    blockedIP.block.mockReset().mockResolvedValue({});
    authFail.getIPsWithHighAttempts.mockResolvedValue([]);
    audit.record.mockReset().mockImplementation(async () => {
      audit.inTransaction.push(audit.txActive);
      return null;
    });
    audit.inTransaction = [];
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

  it('records security.blocked_ip.auto_added per added IP inside its block transaction', async () => {
    authFail.getIPsWithHighAttempts.mockResolvedValue([
      { ip: '1.1.1.1', attempts: 12 },
      { ip: '2.2.2.2', attempts: 15 },
    ]);
    const { req, res } = mocks(ADMIN);
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().blocked).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'security.blocked_ip.auto_added',
      target: { kind: 'settings', id: 'blocked-ip:1.1.1.1' },
      details: { ip: '1.1.1.1', attempts: 12 },
    });
    expect(audit.inTransaction).toEqual([true, true]);
  });

  it('records nothing when no IP crosses the threshold', async () => {
    const { req, res } = mocks(ADMIN);
    await mockRefs.postHandler!(req, res);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips an IP whose block write fails without recording it', async () => {
    authFail.getIPsWithHighAttempts.mockResolvedValue([{ ip: '1.1.1.1', attempts: 12 }]);
    blockedIP.block.mockRejectedValue(new Error('write failed'));
    const { req, res } = mocks(ADMIN);
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().blocked).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('fails the run when the audit write rejects instead of reporting the IP as blocked', async () => {
    authFail.getIPsWithHighAttempts.mockResolvedValue([{ ip: '1.1.1.1', attempts: 12 }]);
    audit.record.mockRejectedValue(new Error('audit down'));
    const { req, res } = mocks(ADMIN);
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow('audit down');
    expect(res._isEndCalled()).toBe(false);
  });
});
