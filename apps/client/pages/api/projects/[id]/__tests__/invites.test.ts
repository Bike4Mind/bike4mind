import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
  postMiddleware: [] as unknown[],
  accounts: [] as Array<{ email: string }>,
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
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit }));

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
  User: { find: () => ({ collation: () => ({ lean: () => Promise.resolve(mockRefs.accounts) }) }) },
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
    mockRefs.accounts = [];
    tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: true, expiresAt: new Date() });
  });

  it('rate limits invite creation per user with a route-wide bucket', () => {
    expect(mockRefs.postMiddleware).toEqual([
      expect.any(Function),
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

  const postInvite = async (
    pending: string[],
    user: Record<string, unknown> = { id: 'u1', name: 'Sharer', email: 'sharer@example.com' }
  ) => {
    createInvite.mockResolvedValue({
      id: 'inv-2',
      token: 'tok-2',
      inviterId: 'u1',
      recipients: { pending },
      typedRecipients: pending,
    });
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: '507f1f77bcf86cd799439033' },
      body: { permissions: ['read'], recipients: pending, description: 'Custom note from the inviter' },
    });
    (req as any).user = user;
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
  };

  it('emails an address with no account the fixed template only, without the custom message', async () => {
    mockRefs.accounts = [];

    await postInvite(['new.person@example.com']);

    await vi.waitFor(() => expect(sendInviteNotificationEmails).toHaveBeenCalledTimes(1));
    expect(sendInviteNotificationEmails).toHaveBeenCalledWith(
      ['new.person@example.com'],
      'Sharer',
      'sharer@example.com',
      'a project',
      'project',
      expect.stringMatching(/\/share\/tok-2$/)
    );
    expect(sendInviteNotificationEmails.mock.calls[0]).toHaveLength(6);
  });

  it('still sends the custom message to a recipient who has an account', async () => {
    mockRefs.accounts = [{ email: 'Friend@Example.com' }];

    await postInvite(['friend@example.com', 'new.person@example.com']);

    await vi.waitFor(() => expect(sendInviteNotificationEmails).toHaveBeenCalledTimes(2));
    expect(sendInviteNotificationEmails).toHaveBeenCalledWith(
      ['friend@example.com'],
      'Sharer',
      'sharer@example.com',
      'a project',
      'project',
      expect.stringMatching(/\/share\/tok-2$/),
      'Custom note from the inviter'
    );
    const strangerCall = sendInviteNotificationEmails.mock.calls.find(call => call[0][0] === 'new.person@example.com');
    expect(strangerCall).toHaveLength(6);
  });

  it('caps a long inviter name in an email to an address with no account', async () => {
    mockRefs.accounts = [];
    const longName = 'N'.repeat(500);

    await postInvite(['new.person@example.com'], { id: 'u1', name: longName, email: 'sharer@example.com' });

    await vi.waitFor(() => expect(sendInviteNotificationEmails).toHaveBeenCalledTimes(1));
    const sentName = sendInviteNotificationEmails.mock.calls[0][1] as string;
    expect(sentName).toHaveLength(60);
    expect(sentName).toBe(`${'N'.repeat(57)}...`);
  });

  it('leaves the inviter name whole in an email to an account holder', async () => {
    mockRefs.accounts = [{ email: 'friend@example.com' }];
    const longName = 'N'.repeat(500);

    await postInvite(['friend@example.com'], { id: 'u1', name: longName, email: 'sharer@example.com' });

    await vi.waitFor(() => expect(sendInviteNotificationEmails).toHaveBeenCalledTimes(1));
    expect(sendInviteNotificationEmails.mock.calls[0][1]).toBe(longName);
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
