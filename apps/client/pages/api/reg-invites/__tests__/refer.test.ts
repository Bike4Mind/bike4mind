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
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/managers/regInviteManager', () => ({
  createRegInvite: vi.fn(async (invite: any) => ({ ...invite, id: 'invite-1' })),
  generateCode: vi.fn(() => 'CODE123'),
}));
vi.mock('@server/utils/mailer/emailHelpers', () => ({
  getLogoUrl: vi.fn(() => ''),
  buildEmailLogoImg: vi.fn(() => ''),
}));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn() }));
const mockEmailPublish = vi.fn();
vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: (...a: any[]) => mockEmailPublish(...a) } },
}));

const mockUserUpdate = vi.fn();
const mockInviteFindOne = vi.fn();
vi.mock('@bike4mind/database', () => ({
  registrationInviteRepository: { findOne: (...a: any[]) => mockInviteFindOne(...a) },
  userRepository: { update: (...a: any[]) => mockUserUpdate(...a) },
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

import { getSettingsValue } from '@bike4mind/utils';
import handler from '@pages/api/reg-invites/refer';

function makeReqRes(user: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).body = {
    userName: 'Sender',
    friendEmail: ['friend@example.com'],
    emailTitle: 'Join me',
    emailBody: 'Come try this',
  };
  (req as any).user = user;
  (req as any).ability = {};
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('/api/reg-invites/refer — sender verification gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInviteFindOne.mockResolvedValue(null);
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
    expect(mockInviteFindOne).not.toHaveBeenCalled();
    expect(mockUserUpdate).not.toHaveBeenCalled();
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

describe('/api/reg-invites/refer — passwordless email content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInviteFindOne.mockResolvedValue(null);
    mockUserUpdate.mockResolvedValue(undefined);
    process.env.APP_URL = 'https://app.test.local';
    // Enable the email path so the body is published and can be asserted.
    vi.mocked(getSettingsValue).mockImplementation((key: string) => key === 'EnableReferralToEmail');
  });

  it('omits the invite code and the ?code= param from the referral email', async () => {
    const { req, res } = makeReqRes({
      id: 'user-1',
      emailVerified: true,
      authProviders: [],
      numReferralsAvailable: 3,
    });

    await handler(req as any, res as any);

    expect(mockEmailPublish).toHaveBeenCalledTimes(1);
    const { body } = mockEmailPublish.mock.calls[0][0] as { body: string };
    // Register link points at the bare /register page - no invite-code query param.
    expect(body).toContain('href="https://app.test.local/register"');
    expect(body).not.toContain('?code=');
    // The dead "invite code to sign up" copy is gone (code is CODE123 per the mock).
    expect(body).not.toContain('invite code to sign up');
    expect(body).not.toContain('CODE123');
  });
});
