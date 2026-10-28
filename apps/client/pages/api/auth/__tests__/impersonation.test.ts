import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = vi.hoisted(() => ({
  get: undefined as Handler | undefined,
  post: undefined as Handler | undefined,
  session: vi.fn(),
  claim: vi.fn(),
  record: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (fn: Handler) => {
      h.get = fn;
      return {
        post: (post: Handler) => {
          h.post = post;
          return post;
        },
      };
    },
  }),
}));
vi.mock('@bike4mind/database', () => ({
  authSessionRepository: { findBySid: h.session },
  AuthSessionModel: { findOneAndUpdate: h.claim },
  SupportAccess: { findOneAndUpdate: h.record },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/utils/adminAudit', () => ({
  parseAdminActionReason: (reason: unknown) => {
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 500)
      throw new Error('Invalid reason');
    return reason.trim();
  },
  recordAdminActionFromRequest: h.audit,
}));
import '../impersonation';

const request = (reason: unknown = 'Investigate reported bug') => {
  const { req, res } = createMocks({ method: 'POST', body: { reason } });
  return {
    req: Object.assign(req, {
      user: { id: 'customer', sid: 'sid', impersonatedBy: 'admin', name: 'Customer' },
    }) as unknown as Request,
    res: res as unknown as Response,
  };
};
describe('support access state and escalation endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.claim.mockResolvedValue({ sid: 'sid', impersonationExpiresAt: new Date(Date.now() + 60000) });
    h.record.mockResolvedValue({ sid: 'sid' });
    h.audit.mockResolvedValue({ id: 'entry' });
  });
  it.each([undefined, '', 'abc', 'x'.repeat(501)])(
    'refuses an invalid reason before changing state: %s',
    async reason => {
      const { req, res } = request(null);
      req.body.reason = reason;
      await expect(h.post!(req, res)).rejects.toThrow('Invalid reason');
      expect(h.claim).not.toHaveBeenCalled();
    }
  );
  it('binds escalation to a live, unrevoked session and attributes its audit', async () => {
    const { req, res } = request();
    await h.post!(req, res);
    expect(h.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'customer',
        sid: 'sid',
        impersonatedBy: 'admin',
        revokedAt: null,
        impersonationExpiresAt: { $gt: expect.any(Date) },
        impersonationWriteEnabled: { $ne: true },
      }),
      { $set: { impersonationWriteEnabled: true } },
      { new: true }
    );
    expect(h.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'user.impersonation.escalated',
        reason: 'Investigate reported bug',
        related: { impersonationSessionId: 'sid' },
      })
    );
  });
  it('refuses expired and concurrent duplicate escalation without an audit', async () => {
    h.claim.mockResolvedValue(null);
    const { req, res } = request();
    await expect(h.post!(req, res)).rejects.toThrow('expired');
    expect(h.audit).not.toHaveBeenCalled();
  });
  it('refuses escalation by an ordinary session', async () => {
    const { req, res } = request();
    delete req.user!.impersonatedBy;
    await expect(h.post!(req, res)).rejects.toThrow('No active');
    expect(h.claim).not.toHaveBeenCalled();
  });
  it('returns persisted mode and deadline, never the reason', async () => {
    const { req, res } = request();
    h.session.mockResolvedValue({
      impersonatedBy: 'admin',
      expiresAt: new Date(Date.now() + 60000),
      impersonationExpiresAt: new Date(Date.now() + 60000),
      impersonationWriteEnabled: true,
      reason: 'private',
    });
    await h.get!(req, res);
    expect(JSON.stringify((res as unknown as { _getJSONData(): unknown })._getJSONData())).not.toContain('private');
  });
});
