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

const candidates = vi.hoisted(() => ({ list: [] as Array<{ ip: string; attempts: number }> }));
// Stands in for the shared runner: hands every candidate to the injected block() and, like the real
// runner, skips an IP whose block() throws.
const runner = vi.hoisted(() => ({ runOauthAbuseAutoBlock: vi.fn() }));
vi.mock('@bike4mind/server-utils/security/oauthAbuseAutoBlock', () => runner);
const EVALUATED_SINCE = new Date('2026-01-01T00:00:00Z');
const blockedIP = vi.hoisted(() => ({
  block: vi.fn().mockResolvedValue({ doc: {}, created: true }),
}));
const audit = vi.hoisted(() => ({ record: vi.fn(), inTransaction: [] as boolean[], txActive: false }));
vi.mock('@bike4mind/database', () => ({
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
  Object.assign(req, { logger: { warn: vi.fn(), error: vi.fn() } });
  return { req, res };
}

const ADMIN = { id: 'admin1', isAdmin: true };

describe('POST /api/security/blocked-ips/evaluate - admin gate', () => {
  beforeEach(() => {
    candidates.list = [];
    runner.runOauthAbuseAutoBlock.mockReset().mockImplementation(async ({ deps }) => {
      const blocked = [];
      const failed: string[] = [];
      for (const { ip, attempts } of candidates.list) {
        const options = { durationMs: 600_000, source: 'auto' as const, escalationLevel: 0 };
        try {
          const { created } = await deps.block(ip, `Auto-blocked: ${attempts} failed sign-ins in 10 minutes`, options);
          if (created) blocked.push({ ip, attempts, durationMs: options.durationMs, escalationLevel: 0 });
        } catch {
          // The real runner logs and moves on.
          failed.push(ip);
        }
      }
      return { evaluatedSince: EVALUATED_SINCE, blocked, failed };
    });
    blockedIP.block.mockReset().mockResolvedValue({ doc: {}, created: true });
    audit.record.mockReset().mockImplementation(async () => {
      audit.inTransaction.push(audit.txActive);
      return null;
    });
    audit.inTransaction = [];
  });

  it('rejects a non-admin before the runner is called', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/admin/i);
    expect(runner.runOauthAbuseAutoBlock).not.toHaveBeenCalled();
  });

  it('delegates to the shared runner for an admin and returns blocked IP strings', async () => {
    candidates.list = [{ ip: '1.1.1.1', attempts: 30 }];
    const { req, res } = mocks(ADMIN);
    await mockRefs.postHandler!(req, res);
    expect(runner.runOauthAbuseAutoBlock).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({
      blocked: ['1.1.1.1'],
      failed: [],
      evaluatedSince: EVALUATED_SINCE.toISOString(),
    });
  });

  it('records security.blocked_ip.auto_added per added IP inside its block transaction', async () => {
    candidates.list = [
      { ip: '1.1.1.1', attempts: 12 },
      { ip: '2.2.2.2', attempts: 15 },
    ];
    const { req, res } = mocks(ADMIN);
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().blocked).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'security.blocked_ip.auto_added',
      target: { kind: 'settings', id: 'blocked-ip:1.1.1.1' },
      details: { ip: '1.1.1.1', durationMs: 600_000, escalationLevel: 0 },
      reason: 'Auto-blocked: 12 failed sign-ins in 10 minutes',
    });
    expect(audit.inTransaction).toEqual([true, true]);
  });

  it('records nothing when no IP crosses the threshold', async () => {
    const { req, res } = mocks(ADMIN);
    await mockRefs.postHandler!(req, res);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips an IP whose block write fails without recording it', async () => {
    candidates.list = [{ ip: '1.1.1.1', attempts: 12 }];
    blockedIP.block.mockRejectedValue(new Error('write failed'));
    const { req, res } = mocks(ADMIN);
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ blocked: [], failed: ['1.1.1.1'] });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps blocking the remaining IPs after an audit write rejects, then fails the run listing it', async () => {
    candidates.list = [
      { ip: '1.1.1.1', attempts: 12 },
      { ip: '2.2.2.2', attempts: 15 },
    ];
    audit.record.mockRejectedValueOnce(new Error('audit down'));
    const { req, res } = mocks(ADMIN);
    await mockRefs.postHandler!(req, res);
    expect(blockedIP.block).toHaveBeenCalledTimes(2);
    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toMatchObject({ auditFailed: ['1.1.1.1'], blocked: ['2.2.2.2'] });
  });

  it('does not re-audit an IP that already has an active block', async () => {
    candidates.list = [{ ip: '1.1.1.1', attempts: 12 }];
    blockedIP.block.mockResolvedValue({ doc: { ip: '1.1.1.1' }, created: false });
    const { req, res } = mocks(ADMIN);
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().blocked).toEqual([]);
    expect(blockedIP.block).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
