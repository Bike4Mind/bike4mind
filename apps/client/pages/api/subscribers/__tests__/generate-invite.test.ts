import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findSubscriber: vi.fn(),
  markInviteGenerated: vi.fn(),
  findInvite: vi.fn(),
  createInvite: vi.fn(),
  publish: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));
vi.mock('@bike4mind/database', () => ({
  subscriberRepository: { findById: h.findSubscriber, markInviteGenerated: h.markInviteGenerated },
  registrationInviteRepository: { findOne: h.findInvite, create: h.createInvite },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/managers/regInviteManager', () => ({ generateCode: () => 'CODE-123' }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

process.env.APP_URL = 'https://app.test';
await import('../generate-invite');

const body = { subscriberId: 'sub-1', email: 'jane@example.test', firstName: 'Jane', lastName: 'Doe' };

const run = async () => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { body, user: { id: 'admin-1', isAdmin: true } });
  await h.handler!(req, res);
  return { req, res };
};

describe('POST /api/subscribers/generate-invite - admin audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.findSubscriber.mockResolvedValue({ id: 'sub-1', inviteGenerated: false });
    h.findInvite.mockResolvedValue(null);
    h.createInvite.mockResolvedValue({ id: 'inv-1', status: 'open', unlimitedUse: false });
    h.markInviteGenerated.mockResolvedValue({});
    h.publish.mockResolvedValue(undefined);
    h.audit.mockResolvedValue(null);
  });

  it('records a strict .created entry inside the write, without the invite code', async () => {
    const { req, res } = await run();
    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'user.reg_invite.created',
        target: { kind: 'settings', id: 'inv-1', displayName: 'invite for jane@example.test' },
      })
    );
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('CODE-123');
    expect(h.markInviteGenerated.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
    expect(h.audit.mock.invocationCallOrder[0]).toBeLessThan(h.publish.mock.invocationCallOrder[0]);
  });

  it('does not report success or send the invite email when the audit write rejects', async () => {
    h.audit.mockRejectedValueOnce(new Error('audit down'));
    const { req, res } = createMocks({ method: 'POST' });
    Object.assign(req, { body, user: { id: 'admin-1', isAdmin: true } });
    await expect(h.handler!(req, res)).rejects.toThrow(/audit down/);
    expect(res._isEndCalled()).toBe(false);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('keeps the committed invite when the invite email fails to publish', async () => {
    h.publish.mockRejectedValueOnce(new Error('bus down'));
    const { req, res } = createMocks({ method: 'POST' });
    Object.assign(req, { body, user: { id: 'admin-1', isAdmin: true } });
    await expect(h.handler!(req, res)).rejects.toThrow(/bus down/);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(res._isEndCalled()).toBe(false);
  });
});
