import { describe, it, expect, vi, beforeEach } from 'vitest';

const issueSession = vi.fn();
const guardedWrite = vi.fn(async (_id: string, write: () => Promise<unknown>) => write());
vi.mock('./withAccountNotPurging', () => ({
  withAccountNotPurging: (...args: Parameters<typeof guardedWrite>) => guardedWrite(...args),
}));

vi.mock('@bike4mind/services', () => ({
  authSessionService: { issueSession: (...args: unknown[]) => issueSession(...args) },
}));
const userDoc = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('@bike4mind/database', () => ({
  authSessionRepository: {},
  User: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(userDoc.value) }) }) },
}));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('./tokenGenerator', () => ({ authTokenGenerator: { signAccessToken: vi.fn() } }));
vi.mock('./sessionDevice', () => ({ buildSessionDevice: () => ({ label: 'test' }) }));
vi.mock('@bike4mind/server-utils/auth/refreshCookie', () => ({ setRefreshCookie: vi.fn() }));
const recordLoginEvent = vi.fn();
vi.mock('./networkMeta', () => ({ recordLoginEvent: (...args: unknown[]) => recordLoginEvent(...args) }));

import { issueSessionForRequest } from './issueSession';

const req = { headers: {} };

describe('issueSessionForRequest', () => {
  beforeEach(() => {
    issueSession.mockReset();
    userDoc.value = { isPersona: false };
    guardedWrite.mockClear();
    recordLoginEvent.mockReset();
    issueSession.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', sid: 's' });
  });

  it('forwards clientId to the session service', async () => {
    await issueSessionForRequest(req, 'u1', { createdVia: 'oauth-token', tokenVersion: 0, clientId: 'c1' });
    expect(issueSession).toHaveBeenCalledWith('u1', expect.objectContaining({ clientId: 'c1' }), expect.anything());
    expect(guardedWrite).toHaveBeenCalledWith('u1', expect.any(Function));
  });

  it('leaves clientId unset when the caller passes none', async () => {
    await issueSessionForRequest(req, 'u1', { createdVia: 'device', tokenVersion: 0 });
    expect(issueSession.mock.calls[0][1].clientId).toBeUndefined();
  });

  it('logs a login AuthEvent keyed on how the session was minted', async () => {
    await issueSessionForRequest(req, 'u1', { createdVia: 'oauth', tokenVersion: 0 });
    expect(recordLoginEvent).toHaveBeenCalledWith({ req, userId: 'u1', method: 'oauth' });
  });

  it.each(['impersonation', 'legacy-migration', 'mfa-setup'] as const)(
    'logs no login for a %s session',
    async createdVia => {
      await issueSessionForRequest(req, 'u1', { createdVia, tokenVersion: 0 });
      expect(recordLoginEvent).not.toHaveBeenCalled();
    }
  );

  describe('test personas', () => {
    const future = () => new Date(Date.now() + 60_000);
    const past = () => new Date(Date.now() - 60_000);

    it('issues for an ordinary account whatever its origin', async () => {
      await issueSessionForRequest(req, 'u1', { createdVia: 'otc', tokenVersion: 0 });
      expect(issueSession).toHaveBeenCalled();
    });

    it('issues when the user is not found', async () => {
      userDoc.value = null;
      await issueSessionForRequest(req, 'u1', { createdVia: 'otc', tokenVersion: 0 });
      expect(issueSession).toHaveBeenCalled();
    });

    it.each(['otc', 'otc-registration', 'oauth', 'okta', 'saml', 'emergency', 'legacy-migration'] as const)(
      'refuses a %s session for a persona',
      async createdVia => {
        userDoc.value = { isPersona: true, personaExpiresAt: future() };
        await expect(issueSessionForRequest(req, 'u1', { createdVia, tokenVersion: 0 })).rejects.toThrow(
          'Test personas can only sign in through the persona mint endpoint or an OAuth client.'
        );
        expect(issueSession).not.toHaveBeenCalled();
      }
    );

    it.each(['oauth-token', 'ios', 'device'] as const)('issues a %s session for a live persona', async createdVia => {
      userDoc.value = { isPersona: true, personaExpiresAt: future() };
      await issueSessionForRequest(req, 'u1', { createdVia, tokenVersion: 0 });
      expect(issueSession).toHaveBeenCalled();
    });

    it('refuses an oauth-token session for an expired persona', async () => {
      userDoc.value = { isPersona: true, personaExpiresAt: past() };
      await expect(issueSessionForRequest(req, 'u1', { createdVia: 'oauth-token', tokenVersion: 0 })).rejects.toThrow(
        'This test persona has expired.'
      );
      expect(issueSession).not.toHaveBeenCalled();
    });

    it('issues a persona-mint session for a live persona', async () => {
      userDoc.value = { isPersona: true, personaExpiresAt: future() };
      await issueSessionForRequest(req, 'u1', { createdVia: 'persona-mint', tokenVersion: 0 });
      expect(issueSession).toHaveBeenCalled();
    });

    it('refuses a persona-mint session for an expired persona', async () => {
      userDoc.value = { isPersona: true, personaExpiresAt: past() };
      await expect(issueSessionForRequest(req, 'u1', { createdVia: 'persona-mint', tokenVersion: 0 })).rejects.toThrow(
        'This test persona has expired.'
      );
      expect(issueSession).not.toHaveBeenCalled();
    });

    it('issues an impersonation session for a persona', async () => {
      userDoc.value = { isPersona: true, personaExpiresAt: past() };
      await issueSessionForRequest(req, 'u1', { createdVia: 'impersonation', tokenVersion: 0 });
      expect(issueSession).toHaveBeenCalled();
    });
  });
});
