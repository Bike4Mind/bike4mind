import { describe, it, expect, vi, beforeEach } from 'vitest';

const issueSession = vi.fn();

vi.mock('@bike4mind/services', () => ({
  authSessionService: { issueSession: (...args: unknown[]) => issueSession(...args) },
}));
vi.mock('@bike4mind/database', () => ({ authSessionRepository: {} }));
vi.mock('./tokenGenerator', () => ({ authTokenGenerator: { signAccessToken: vi.fn() } }));
vi.mock('./sessionDevice', () => ({ buildSessionDevice: () => ({ label: 'test' }) }));
vi.mock('@bike4mind/server-utils/auth/refreshCookie', () => ({ setRefreshCookie: vi.fn() }));

import { issueSessionForRequest } from './issueSession';

const req = { headers: {} };

describe('issueSessionForRequest', () => {
  beforeEach(() => {
    issueSession.mockReset();
    issueSession.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', sid: 's' });
  });

  it('forwards clientId to the session service', async () => {
    await issueSessionForRequest(req, 'u1', { createdVia: 'oauth-token', tokenVersion: 0, clientId: 'c1' });
    expect(issueSession).toHaveBeenCalledWith('u1', expect.objectContaining({ clientId: 'c1' }), expect.anything());
  });

  it('leaves clientId unset when the caller passes none', async () => {
    await issueSessionForRequest(req, 'u1', { createdVia: 'device', tokenVersion: 0 });
    expect(issueSession.mock.calls[0][1].clientId).toBeUndefined();
  });
});
