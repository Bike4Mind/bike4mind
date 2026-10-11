import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
  postMiddleware: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: (...fns: any[]) => {
      mockRefs.postMiddleware = fns.slice(0, -1);
      mockRefs.postHandler = fns[fns.length - 1];
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const createInvite = vi.hoisted(() => vi.fn());
const listInvites = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({
  sharingService: { createInvite },
  projectService: { listInvites },
}));

const tryIncrementWithinLimitFixedWindow = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn((options: unknown) => ({ rateLimitOptions: options })));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit }));

vi.mock('@bike4mind/database', () => ({
  cacheRepository: { tryIncrementWithinLimitFixedWindow },
  projectRepository: {},
  inviteRepository: {},
  userRepository: {},
  fabFileRepository: {},
  sessionRepository: {},
  organizationRepository: {},
  withTransaction: (fn: any) => fn(),
  // Return null so the ADD_MEMBER logEvent block is skipped for tests with empty pending.
  Project: { findById: () => Promise.resolve(null) },
  Group: {},
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

const sendInviteNotificationEmails = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/mailer/inviteNotificationEmail', () => ({
  getInviteTypeName: () => 'project',
  sendInviteNotificationEmails,
}));

import '@pages/api/projects/[id]/invites';

/**
 * POST /api/projects/:id/invites security property: the path id is authoritative.
 * Before this PR, spreading req.body as any after `id` let a caller pass {"id":"<other>"}
 * to mint a share link for a different project. The schema parse strips unknown keys,
 * so only the query param id reaches the service.
 */
describe('POST /api/projects/:id/invites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createInvite.mockResolvedValue({ id: 'inv-1', recipients: { pending: [] } });
    tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: true, expiresAt: new Date() });
  });

  it('rate limits invite creation per user with a route-wide bucket', () => {
    expect(mockRefs.postMiddleware).toEqual([
      { rateLimitOptions: expect.objectContaining({ bucket: 'POST /api/projects/[id]/invites' }) },
    ]);
  });

  it('refuses more recipients than one request may name', async () => {
    const recipients = Array.from({ length: 26 }, (_, i) => `507f1f77bcf86cd7994390${String(i).padStart(2, '0')}`);
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'], recipients },
    });
    (req as any).user = { id: 'u1' };

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('refuses an over-long message, which would be mailed to every recipient', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'], recipients: ['a@example.com'], description: 'x'.repeat(1001) },
    });
    (req as any).user = { id: 'u1' };

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('charges each typed address against the hourly budget and stops once it is spent', async () => {
    tryIncrementWithinLimitFixedWindow
      .mockResolvedValueOnce({ success: true, expiresAt: new Date() })
      .mockResolvedValueOnce({ success: false, expiresAt: new Date() });
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'], recipients: ['a@example.com', '507f1f77bcf86cd799439034', 'b@example.com'] },
    });
    (req as any).user = { id: 'u1' };

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Too many email invitations/);
    expect(tryIncrementWithinLimitFixedWindow).toHaveBeenCalledTimes(2);
    expect(tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
      'rate-limit:u1:project-invite-typed-address',
      20,
      60 * 60 * 1000
    );
    expect(createInvite).not.toHaveBeenCalled();
    expect(sendInviteNotificationEmails).not.toHaveBeenCalled();
  });

  it('does not charge the typed-address budget for recipients named by user id', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'], recipients: ['507f1f77bcf86cd799439034'] },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    expect(tryIncrementWithinLimitFixedWindow).not.toHaveBeenCalled();
    expect(createInvite).toHaveBeenCalledOnce();
  });

  it('does not allow a body id to redirect the invite to a different project', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439031' },
      body: { permissions: ['read'], id: '507f1f77bcf86cd799439032' },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    expect(createInvite).toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ id: '507f1f77bcf86cd799439031', type: 'Project' }),
      expect.anything()
    );
    expect(createInvite).not.toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ id: '507f1f77bcf86cd799439032' }),
      expect.anything()
    );
  });

  it('creates the invite for the path project id', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'] },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    expect(createInvite).toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ id: '507f1f77bcf86cd799439033', type: 'Project' }),
      expect.anything()
    );
  });

  it('emails the pending recipients a link to the invite', async () => {
    createInvite.mockResolvedValue({
      id: 'inv-2',
      token: 'tok-2',
      inviterId: 'u1',
      recipients: { pending: ['new.person@example.com'] },
      typedRecipients: ['new.person@example.com'],
    });
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'], recipients: ['new.person@example.com'] },
    });
    (req as any).user = { id: 'u1', name: 'Sharer', email: 'sharer@example.com' };

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(sendInviteNotificationEmails).toHaveBeenCalledWith(
      ['new.person@example.com'],
      'Sharer',
      'sharer@example.com',
      'a project',
      'project',
      expect.stringMatching(/\/share\/tok-2$/),
      undefined
    );
  });

  it('sends no email when the invite has no pending recipients', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'] },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    expect(sendInviteNotificationEmails).not.toHaveBeenCalled();
  });

  it('returns 400 when id is missing from the path', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: {},
      body: { permissions: ['read'] },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('accepts a future ISO expiresAt and coerces it to Date', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'], expiresAt: '2099-12-31T00:00:00.000Z' },
    });
    (req as any).user = { id: 'u1' };
    await mockRefs.postHandler!(req, res);
    expect(createInvite).toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ expiresAt: expect.any(Date) }),
      expect.anything()
    );
  });

  it('maps null expiresAt to undefined so the service prefault applies', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'], expiresAt: null },
    });
    (req as any).user = { id: 'u1' };
    await mockRefs.postHandler!(req, res);
    expect(createInvite).not.toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ expiresAt: expect.anything() }),
      expect.anything()
    );
  });

  it('rejects a past expiresAt without calling the service', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'], expiresAt: '2020-01-01T00:00:00.000Z' },
    });
    (req as any).user = { id: 'u1' };
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('rejects a missing permissions field without calling the service', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: {},
    });
    (req as any).user = { id: 'u1' };
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();
    expect(createInvite).not.toHaveBeenCalled();
  });
});
