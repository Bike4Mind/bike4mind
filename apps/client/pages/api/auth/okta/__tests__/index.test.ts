import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

vi.mock('@server/middlewares/baseApi', () => {
  const chain = { use: () => chain, get: (fn: Handler) => fn };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/utils/validators', () => ({
  validateAppUrl: () => 'https://app.example.com',
  isLocalAppUrl: () => false,
}));
vi.mock('@server/auth/oktaOidcClient', () => ({
  getOktaConfigWithFallback: vi
    .fn()
    .mockResolvedValue({ config: {}, source: 'db', idp: { id: 'idp-1', isActive: true } }),
  generatePkceParams: vi.fn().mockResolvedValue({ codeVerifier: 'verifier', codeChallenge: 'challenge' }),
  buildAuthorizationUrl: vi.fn().mockResolvedValue(new URL('https://okta.example.com/authorize')),
}));
vi.mock('@server/auth/oauthFlowCookie', () => ({
  issueStateNonce: () => 'nonce-hash',
  setPkceVerifierCookie: vi.fn(),
}));
const mockCreateStateToken = vi.fn().mockReturnValue('state-token');
vi.mock('@server/auth/jwtStateStore', () => ({
  createStateToken: (...a: unknown[]) => mockCreateStateToken(...a),
}));

import handler from '../index';

async function start(redirectTo: string) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: 'GET',
    query: { idp: 'idp-1', redirectTo },
  });
  await (handler as unknown as Handler)(req, res);
  expect(res._getRedirectUrl()).toBe('https://okta.example.com/authorize');
  return mockCreateStateToken.mock.calls[0][1];
}

describe('/api/auth/okta - OAuth client in the signed state', () => {
  beforeEach(() => {
    mockCreateStateToken.mockClear();
  });

  it('puts the client_id of an authorize redirectTo into the state payload', async () => {
    const redirectTo = '/oauth/authorize?client_id=b4m_sat_0123abcd&response_type=code';
    expect(await start(redirectTo)).toEqual({ idpId: 'idp-1', redirectTo, clientId: 'b4m_sat_0123abcd' });
  });

  it('leaves clientId unset when redirectTo is not an authorize path', async () => {
    expect(await start('/settings?client_id=b4m_sat_0123abcd')).toMatchObject({ clientId: undefined });
  });
});
