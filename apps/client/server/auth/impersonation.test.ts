import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

const h = vi.hoisted(() => ({ find: vi.fn(), claim: vi.fn(), revoke: vi.fn(), audit: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  SupportAccess: { findOne: () => ({ select: h.find }), findOneAndUpdate: h.claim },
  authSessionRepository: { revokeBySid: h.revoke },
  withTransaction: async (fn: () => Promise<void>) => fn(),
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionForActor: h.audit }));
import { customerSupportAccess, endImpersonation, impersonationLifetimeMs } from './impersonation';

const actor = { kind: 'user' as const, scope: 'platform' as const, userId: 'admin', name: 'Admin', wasAdmin: true };
const row = {
  sid: 'sid',
  userId: 'customer',
  adminId: 'admin',
  reason: 'Internal reason',
  startedAt: new Date(1000),
  expiresAt: new Date(61000),
  escalatedAt: new Date(2000),
  escalationReason: 'Internal escalation',
};

describe('support access lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.find.mockResolvedValue(row);
    h.audit.mockResolvedValue({ id: 'audit' });
  });
  it('has a configurable default of 60 minutes and refuses invalid configuration', () => {
    expect(impersonationLifetimeMs()).toBe(3_600_000);
    vi.stubEnv('IMPERSONATION_TTL_MINUTES', '15');
    expect(impersonationLifetimeMs()).toBe(900_000);
    vi.stubEnv('IMPERSONATION_TTL_MINUTES', 'NaN');
    expect(impersonationLifetimeMs).toThrow();
    vi.unstubAllEnvs();
  });
  it('projects only customer-safe fields and caps expired duration at the hard deadline', () => {
    const projected = customerSupportAccess(row, new Date(100000));
    expect(projected).toEqual({
      id: 'sid',
      message: 'Support accessed your account',
      startedAt: row.startedAt.toISOString(),
      endedAt: row.expiresAt.toISOString(),
      durationMs: 60_000,
    });
    expect(JSON.stringify(projected)).not.toMatch(/Internal|admin|reason|escalat/);
  });
  it('atomically claims the end once across concurrent expiry and return calls', async () => {
    h.claim.mockResolvedValueOnce(row).mockResolvedValue(null);
    await Promise.all([endImpersonation({} as Request, 'sid', actor), endImpersonation({} as Request, 'sid', actor)]);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      { ...actor, impersonatedUserId: 'customer' },
      expect.objectContaining({
        reason: 'Internal reason',
        details: { durationMs: 60_000, expired: true, escalated: true },
      })
    );
    expect(h.revoke).toHaveBeenCalledTimes(1);
  });
  it('fails the transaction if the end audit could not be recorded', async () => {
    h.claim.mockResolvedValue(row);
    h.audit.mockResolvedValue(null);
    await expect(endImpersonation({} as Request, 'sid', actor)).rejects.toThrow('Could not record');
  });
});
