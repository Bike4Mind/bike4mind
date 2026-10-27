import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Middleware is stripped so the handler body runs directly (same pattern as
// pages/api/email/__tests__/verify.test.ts).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/managers/regInviteManager', () => ({
  createRegInvite: vi.fn(async (invite: any) => ({ ...invite, id: 'invite-1' })),
  generateCode: vi.fn(() => 'CODE123'),
}));
vi.mock('@bike4mind/server-utils/utils/mailer/emailHelpers', () => ({
  getLogoUrl: vi.fn(() => ''),
  buildEmailLogoImg: vi.fn(() => ''),
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn() }));
const mockEmailPublish = vi.fn();
vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: (...a: any[]) => mockEmailPublish(...a) } },
}));

const mockUserUpdate = vi.fn();
const mockSettleReferrals = vi.fn();
const mockReserveReferrals = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
const mockInviteFind = vi.fn();
vi.mock('@bike4mind/database', () => ({
  registrationInviteRepository: { find: (...a: any[]) => mockInviteFind(...a) },
  userRepository: {
    update: (...a: any[]) => mockUserUpdate(...a),
    reserveReferrals: (...a: unknown[]) => mockReserveReferrals(...a),
    settleReferrals: (...a: unknown[]) => mockSettleReferrals(...a),
  },
  adminSettingsRepository: {},
  User: {
    find: vi.fn(() => ({
      select: () => ({ lean: async () => [] }),
    })),
  },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: vi.fn(() => false),
}));

import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { createRegInvite } from '@server/managers/regInviteManager';
import handler from '@pages/api/reg-invites/refer';

function invokeHandler(req: unknown, res: unknown) {
  return handler(req as Parameters<typeof handler>[0], res as Parameters<typeof handler>[1]);
}

function makeReqRes(user: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).body = {
    userName: 'Sender',
    friendEmail: ['friend@example.com'],
    emailTitle: 'Join me',
    emailBody: 'Come try this',
  };
  (req as any).user = { email: 'sender@example.com', ...user };
  (req as any).ability = {};
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('/api/reg-invites/refer — sender verification gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReserveReferrals.mockResolvedValue(true);
    mockInviteFind.mockResolvedValue([]);
    mockUserUpdate.mockResolvedValue(undefined);
    process.env.APP_URL = 'https://app.test.local';
  });

  it('rejects a sender whose email is unverified and has no OAuth provider', async () => {
    const { req, res } = makeReqRes({
      id: 'user-1',
      emailVerified: false,
      authProviders: [],
      numReferralsAvailable: 3,
    });

    await expect(handler(req as any, res as any)).rejects.toThrow('verify your email');
    // No invite is minted and no referral slot is spent.
    expect(mockInviteFind).not.toHaveBeenCalled();
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockSettleReferrals).not.toHaveBeenCalled();
  });

  it('allows a sender with a verified email', async () => {
    const { req, res } = makeReqRes({
      id: 'user-1',
      emailVerified: true,
      authProviders: [],
      numReferralsAvailable: 3,
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData().sent).toEqual(['friend@example.com']);
  });

  it('allows an OAuth sender (provider-verified email) even when emailVerified is false', async () => {
    const { req, res } = makeReqRes({
      id: 'user-1',
      emailVerified: false,
      authProviders: [{ provider: 'google' }],
      numReferralsAvailable: 3,
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData().sent).toEqual(['friend@example.com']);
  });
});

describe('/api/reg-invites/refer - own-email aliases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReserveReferrals.mockResolvedValue(true);
    mockInviteFind.mockResolvedValue([]);
    process.env.APP_URL = 'https://app.test.local';
  });

  it.each(['sender@example.com', 'SENDER+invite@example.com'])(
    'refuses %s before reserving or minting anything',
    async target => {
      const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true, numReferralsAvailable: 3 });
      (req as any).body.friendEmail = ['friend@example.com', target];

      await expect(handler(req as any, res as any)).rejects.toThrow('cannot invite your own email');
      expect(mockReserveReferrals).not.toHaveBeenCalled();
      expect(mockInviteFind).not.toHaveBeenCalled();
    }
  );

  it('treats Gmail dot and googlemail variants as the sender', async () => {
    const { req, res } = makeReqRes({
      id: 'user-1',
      email: 'jane.doe@gmail.com',
      emailVerified: true,
      numReferralsAvailable: 3,
    });
    (req as any).body.friendEmail = ['janedoe+x@googlemail.com'];

    await expect(handler(req as any, res as any)).rejects.toThrow('cannot invite your own email');
    expect(mockReserveReferrals).not.toHaveBeenCalled();
  });

  it('does not crash for a sender with no email address', async () => {
    const { req, res } = makeReqRes({
      id: 'user-1',
      email: null,
      emailVerified: false,
      authProviders: [{ provider: 'google' }],
      numReferralsAvailable: 3,
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(201);
  });

  it('still accepts a different address', async () => {
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true, numReferralsAvailable: 3 });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(201);
  });
});

describe('/api/reg-invites/refer — passwordless email content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReserveReferrals.mockResolvedValue(true);
    mockInviteFind.mockResolvedValue([]);
    mockUserUpdate.mockResolvedValue(undefined);
    vi.mocked(getSettingsMap).mockResolvedValue({});
    process.env.APP_URL = 'https://app.test.local';
    // Enable the email path so the body is published and can be asserted.
    vi.mocked(getSettingsValue).mockImplementation((key: string) => key === 'EnableReferralToEmail');
  });

  it('includes the newly minted invite code alongside the registration link', async () => {
    const { req, res } = makeReqRes({
      id: 'user-1',
      emailVerified: true,
      authProviders: [],
      numReferralsAvailable: 3,
    });

    await handler(req as any, res as any);

    expect(mockEmailPublish).toHaveBeenCalledTimes(1);
    const { body } = mockEmailPublish.mock.calls[0][0] as { body: string };
    expect(body).toContain('href="https://app.test.local/register"');
    expect(body).toContain('Invite code: <strong>CODE123</strong>');
  });

  it('includes an escaped existing invite code and preserves a custom registration link', async () => {
    mockInviteFind.mockResolvedValue([{ code: '<EXIST&>', userId: 'user-1', status: 'open' }]);
    vi.mocked(getSettingsMap).mockResolvedValueOnce({
      RegistrationLink: 'https://signup.example.com/register?source=email&campaign=invite',
    });
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });

    await invokeHandler(req, res);

    const { body } = mockEmailPublish.mock.calls[0][0] as { body: string };
    expect(body).toContain('Invite code: <strong>&lt;EXIST&amp;&gt;</strong>');
    expect(body).toContain('href="https://signup.example.com/register?source=email&amp;campaign=invite"');
    expect(createRegInvite).not.toHaveBeenCalled();
  });
});

describe('/api/reg-invites/refer - duplicate addresses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReserveReferrals.mockResolvedValue(true);
    mockInviteFind.mockResolvedValue([]);
    mockUserUpdate.mockResolvedValue(undefined);
    process.env.APP_URL = 'https://app.test.local';
  });

  it('normalizes case before reserving one referral for duplicate addresses', async () => {
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    req.body.friendEmail = ['Friend@x.com', 'friend@x.com'];

    await invokeHandler(req, res);

    expect(mockReserveReferrals).toHaveBeenCalledWith('user-1', 1);
    expect(mockInviteFind).toHaveBeenCalledExactlyOnceWith({ email: 'friend@x.com' });
    expect(createRegInvite).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ email: 'friend@x.com' }));
    expect(res._getJSONData()).toMatchObject({ sent: ['friend@x.com'], failed: [] });
  });

  it('dedupes a repeated address before charging the quota', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    (req as any).body = {
      userName: 'Sender',
      friendEmail: ['friend@example.com', 'friend@example.com'],
      emailTitle: 'Join me',
      emailBody: 'Come try this',
    };
    (req as any).user = {
      id: 'user-1',
      email: 'sender@example.com',
      emailVerified: true,
      authProviders: [],
      numReferralsAvailable: 3,
    };
    (req as any).ability = {};
    (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(201);
    // One credit for one distinct address, not one per submitted copy.
    expect(res._getJSONData().sent).toEqual(['friend@example.com']);
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 0, ['invite-1']);
    expect(mockReserveReferrals).toHaveBeenCalledWith('user-1', 1);
  });
});

describe('/api/reg-invites/refer - quota reservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReserveReferrals.mockResolvedValue(true);
    mockInviteFind.mockResolvedValue([]);
    vi.mocked(getSettingsValue).mockReturnValue(false);
    process.env.APP_URL = 'https://app.test.local';
  });

  it('rejects insufficient persisted quota before minting or publishing', async () => {
    mockReserveReferrals.mockResolvedValue(false);
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true, numReferralsAvailable: 100 });
    await expect(invokeHandler(req, res)).rejects.toThrow('Not enough referrals');
    expect(mockReserveReferrals).toHaveBeenCalledWith('user-1', 1);
    expect(mockInviteFind).not.toHaveBeenCalled();
    expect(mockEmailPublish).not.toHaveBeenCalled();
    expect(mockSettleReferrals).not.toHaveBeenCalled();
  });

  it('uses persisted quota even when the auth snapshot has none', async () => {
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true, numReferralsAvailable: 0 });
    await invokeHandler(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(mockReserveReferrals).toHaveBeenCalledWith('user-1', 1);
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 0, ['invite-1']);
  });

  it('refunds a failure before an invite exists', async () => {
    mockInviteFind.mockRejectedValue(new Error('lookup failed'));
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    await invokeHandler(req, res);
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 1, []);
    expect(res._getJSONData()).toMatchObject({ sent: [], failed: ['friend@example.com'] });
  });

  it('marks a minted invite as a referral invite', async () => {
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    await invokeHandler(req, res);
    expect(createRegInvite).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', source: 'referral' }));
  });

  it('refunds a failure to mint the invite', async () => {
    vi.mocked(createRegInvite).mockRejectedValueOnce(new Error('mint failed'));
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    await invokeHandler(req, res);
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 1, []);
    expect(res._getJSONData()).toMatchObject({ sent: [], failed: ['friend@example.com'] });
  });

  it('retains quota and reports an async email failure as failed instead of erroring', async () => {
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'EnableReferralToEmail');
    mockEmailPublish.mockRejectedValueOnce(new Error('publish failed'));
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    await invokeHandler(req, res);
    // The invite exists and the charge stands, so a retry must not be invited by a 5xx.
    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toMatchObject({ sent: [], failed: ['friend@example.com'] });
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 0, ['invite-1']);
  });

  it('awaits in-flight deliveries before responding', async () => {
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'EnableReferralToEmail');
    const delivery = Promise.withResolvers<void>();
    mockEmailPublish.mockReturnValueOnce(delivery.promise);
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    let finished = false;
    const request = invokeHandler(req, res).finally(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(mockSettleReferrals).toHaveBeenCalled());
    expect(finished).toBe(false);
    delivery.resolve();
    await request;
    expect(res._getStatusCode()).toBe(201);
  });

  it('fails the request when settlement fails, after started deliveries finish', async () => {
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'EnableReferralToEmail');
    const delivery = Promise.withResolvers<void>();
    mockEmailPublish.mockReturnValueOnce(delivery.promise);
    const dbError = new Error('settle failed');
    mockSettleReferrals.mockRejectedValueOnce(dbError);
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    const rejected = vi.fn();
    const request = invokeHandler(req, res).catch(rejected);
    await vi.waitFor(() => expect(mockSettleReferrals).toHaveBeenCalled());
    expect(rejected).not.toHaveBeenCalled();
    delivery.resolve();
    await request;
    expect(rejected).toHaveBeenCalledWith(dbError);
  });

  it('reports a delivery failure before failing the request on a settle failure', async () => {
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'EnableReferralToEmail');
    mockEmailPublish.mockRejectedValueOnce(new Error('publish failed'));
    const dbError = new Error('settle failed');
    mockSettleReferrals.mockRejectedValueOnce(dbError);
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(invokeHandler(req, res)).rejects.toBe(dbError);
      // The repair path needs to know which deliveries failed, so that report is logged
      // before the settle failure is rethrown.
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to deliver referral email to friend@example.com')
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('retains quota if publication throws synchronously after minting', async () => {
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'EnableReferralToEmail');
    mockEmailPublish.mockImplementationOnce(() => {
      throw new Error('publish failed');
    });
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    await invokeHandler(req, res);
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 0, ['invite-1']);
    expect(res._getJSONData()).toMatchObject({ failed: ['friend@example.com'] });
  });
});

describe('/api/reg-invites/refer - reusing an existing invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReserveReferrals.mockResolvedValue(true);
    vi.mocked(getSettingsValue).mockReturnValue(false);
    process.env.APP_URL = 'https://app.test.local';
  });

  it("sends through the sender's own existing invite without minting or refunding one", async () => {
    mockInviteFind.mockResolvedValue([{ code: 'EXIST', userId: 'user-1', status: 'open' }]);
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    await invokeHandler(req, res);
    expect(createRegInvite).not.toHaveBeenCalled();
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 0, []);
    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toMatchObject({ sent: ['friend@example.com'], failed: [] });
  });

  it('skips an address another sender already invited, keeps the charge and reports it as sent', async () => {
    mockInviteFind.mockResolvedValue([{ code: 'EXIST', userId: 'someone-else', status: 'open' }]);
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'EnableReferralToEmail');
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    await invokeHandler(req, res);
    expect(createRegInvite).not.toHaveBeenCalled();
    expect(mockEmailPublish).not.toHaveBeenCalled();
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 0, []);
    expect(res._getJSONData()).toMatchObject({ sent: ['friend@example.com'], failed: [] });
  });

  it('skips a mixed-case target with a live invite from another sender', async () => {
    mockInviteFind.mockImplementation(async ({ email }: { email: string }) =>
      email === 'friend@example.com' ? [{ code: 'EXIST', userId: 'someone-else', status: 'open' }] : []
    );
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'EnableReferralToEmail');
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    req.body.friendEmail = ['Friend@Example.com'];

    await invokeHandler(req, res);

    expect(mockInviteFind).toHaveBeenCalledWith({ email: 'friend@example.com' });
    expect(createRegInvite).not.toHaveBeenCalled();
    expect(mockEmailPublish).not.toHaveBeenCalled();
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 0, []);
    expect(res._getJSONData()).toMatchObject({ sent: ['friend@example.com'], failed: [] });
  });

  it("skips another sender's live invite even when a dead invite appears first", async () => {
    mockInviteFind.mockResolvedValue([
      { code: 'DEAD', userId: 'someone-else', status: 'open', expiresAt: new Date(Date.now() - 1000) },
      { code: 'LIVE', userId: 'another-sender', status: 'open' },
    ]);
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'EnableReferralToEmail');
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });

    await invokeHandler(req, res);

    expect(createRegInvite).not.toHaveBeenCalled();
    expect(mockEmailPublish).not.toHaveBeenCalled();
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 0, []);
    expect(res._getJSONData()).toMatchObject({ sent: ['friend@example.com'], failed: [] });
  });

  it("mints a new invite instead of reusing the sender's expired invite", async () => {
    mockInviteFind.mockResolvedValue([
      { code: 'EXPIRED', userId: 'user-1', status: 'open', expiresAt: new Date(Date.now() - 1000) },
    ]);
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'EnableReferralToEmail');
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });

    await invokeHandler(req, res);

    expect(createRegInvite).toHaveBeenCalledWith(expect.objectContaining({ code: 'CODE123', userId: 'user-1' }));
    const { body } = mockEmailPublish.mock.calls[0][0] as { body: string };
    expect(body).toContain('Invite code: <strong>CODE123</strong>');
    expect(body).not.toContain('EXPIRED');
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 0, ['invite-1']);
  });

  it.each([
    ['closed', { status: 'waiting' }],
    ['used', { status: 'used', used: new Date() }],
    ['expired', { status: 'open', expiresAt: new Date(Date.now() - 1000) }],
  ])("mints the sender's own invite when another sender's invite is %s", async (_label, state) => {
    mockInviteFind.mockResolvedValue([{ code: 'EXIST', userId: 'someone-else', ...state }]);
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    await invokeHandler(req, res);
    expect(createRegInvite).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', source: 'referral' }));
    expect(res._getJSONData()).toMatchObject({ sent: ['friend@example.com'], failed: [] });
  });

  it('retains the charge when the existing invite fails to send', async () => {
    mockInviteFind.mockResolvedValue([{ code: 'EXIST', userId: 'user-1', status: 'open' }]);
    vi.mocked(getSettingsValue).mockImplementation(key => key === 'EnableReferralToEmail');
    mockEmailPublish.mockImplementationOnce(() => {
      throw new Error('publish failed');
    });
    const { req, res } = makeReqRes({ id: 'user-1', emailVerified: true });
    await invokeHandler(req, res);
    expect(mockSettleReferrals).toHaveBeenCalledWith('user-1', 0, []);
    expect(res._getJSONData()).toMatchObject({ sent: [], failed: ['friend@example.com'] });
  });
});
