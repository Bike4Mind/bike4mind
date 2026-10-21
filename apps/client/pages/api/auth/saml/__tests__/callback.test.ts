import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const captured = vi.hoisted(() => ({ handler: undefined as Handler | undefined }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    get: (fn: Handler) => {
      captured.handler = fn;
      return chain;
    },
    post: () => chain,
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: () => () => undefined }));

const mockSamlUser = vi.fn();
vi.mock('passport', () => ({
  default: {
    authenticate: (_name: string, cb: (err: Error | null, user: unknown, info: unknown) => Promise<unknown>) => () =>
      cb(null, mockSamlUser(), {}),
  },
}));

vi.mock('@bike4mind/database', () => ({
  authFailLogRepository: { create: vi.fn() },
  identityProviderRepository: {
    findByIdWithSecrets: vi.fn().mockResolvedValue({ id: 'idp-1', isActive: true, type: 'saml' }),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@server/auth/auth', () => ({ setupSamlStrategy: () => 'saml-idp-1' }));
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: vi.fn().mockResolvedValue({ accessToken: 'tok' }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));

const mockStampSourceTag = vi.fn().mockResolvedValue(undefined);
const mockRecordSignupAcquisition = vi.fn().mockResolvedValue({ isSynthetic: false });
const mockEmitSignupFunnelEvents = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/auth/oauthSourceTag', () => ({
  stampOAuthSourceTag: (...a: unknown[]) => mockStampSourceTag(...a),
}));
vi.mock('@server/analytics/funnel', () => ({
  recordSignupAcquisition: (...a: unknown[]) => mockRecordSignupAcquisition(...a),
  emitSignupFunnelEvents: (...a: unknown[]) => mockEmitSignupFunnelEvents(...a),
}));

import '../callback';

const AUTHORIZE_REDIRECT = '/oauth/authorize?client_id=b4m_sat_0123abcd&response_type=code';

async function runCallback(relayState: string) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: 'GET',
    query: { RelayState: relayState },
  });
  Object.assign(req, { ip: '127.0.0.1' });
  await captured.handler!(req, res);
  await vi.waitFor(() => expect(res._getRedirectUrl()).toMatch(/\/auth\/success/));
  return res;
}

describe('/api/auth/saml/callback - OAuth client source tag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stamps a new account with the client_id from the authorize redirectTo', async () => {
    mockSamlUser.mockReturnValue({
      id: 'u-new',
      isBanned: false,
      isNewUser: true,
      emailVerified: true,
      signupCreditsGranted: 0,
    });
    await runCallback(new URLSearchParams({ idp: 'idp-1', redirectTo: AUTHORIZE_REDIRECT }).toString());
    expect(mockStampSourceTag).toHaveBeenCalledWith('u-new', 'b4m_sat_0123abcd');
    expect(mockEmitSignupFunnelEvents).toHaveBeenCalledTimes(1);
    expect(mockEmitSignupFunnelEvents).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'saml', emailVerified: true, creditsGranted: 0 })
    );
  });

  it('never stamps a returning user, even when redirectTo names a client', async () => {
    mockSamlUser.mockReturnValue({ id: 'u-old', isBanned: false });
    await runCallback(new URLSearchParams({ idp: 'idp-1', redirectTo: AUTHORIZE_REDIRECT }).toString());
    expect(mockStampSourceTag).not.toHaveBeenCalled();
  });

  it('passes no clientId when redirectTo is not an authorize path', async () => {
    mockSamlUser.mockReturnValue({ id: 'u-new', isBanned: false, isNewUser: true });
    await runCallback(new URLSearchParams({ idp: 'idp-1', redirectTo: '/settings?client_id=x' }).toString());
    expect(mockStampSourceTag).toHaveBeenCalledWith('u-new', undefined);
  });
});
