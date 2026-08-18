import { describe, it, expect, vi } from 'vitest';
import { issueSession } from './issueSession';
import { hashRefreshSecret, parseRefreshToken } from './refreshTokenFormat';
import { createMockAuthSessionRepository } from '../__tests__/utils/testUtils';

const setup = () => {
  const authSessions = createMockAuthSessionRepository();
  authSessions.create.mockImplementation(async (doc: unknown) => doc as never);
  const signAccessToken = vi.fn().mockReturnValue('ACCESS_JWT');
  return { authSessions, signAccessToken, db: { authSessions } };
};

describe('issueSession', () => {
  it('creates a session row storing only the hash of the refresh secret', async () => {
    const { authSessions, signAccessToken, db } = setup();
    const result = await issueSession('user-1', { createdVia: 'otc', tokenVersion: 3 }, { db, signAccessToken });

    const parsed = parseRefreshToken(result.refreshToken);
    expect(parsed).not.toBeNull();
    const { sid, secret } = parsed!;
    expect(sid).toBe(result.sid);

    const created = authSessions.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.userId).toBe('user-1');
    expect(created.createdVia).toBe('otc');
    // Only the HASH is persisted, never the raw secret.
    expect(created.refreshTokenHash).toBe(hashRefreshSecret(secret));
    expect(JSON.stringify(created)).not.toContain(secret);
    expect(created.revokedAt).toBeNull();
    expect(created.previousRefreshTokenHash).toBeNull();
  });

  it('mints the access token with the sid embedded and returns it', async () => {
    const { signAccessToken, db } = setup();
    const result = await issueSession('user-1', { createdVia: 'otc', tokenVersion: 3 }, { db, signAccessToken });
    expect(result.accessToken).toBe('ACCESS_JWT');
    expect(signAccessToken).toHaveBeenCalledWith('user-1', 3, { sid: result.sid });
  });

  it('threads impersonatedBy onto both the session and the access token', async () => {
    const { authSessions, signAccessToken, db } = setup();
    const result = await issueSession(
      'target',
      { createdVia: 'impersonation', tokenVersion: 0, impersonatedBy: 'admin-1' },
      { db, signAccessToken }
    );
    const created = authSessions.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.impersonatedBy).toBe('admin-1');
    expect(signAccessToken).toHaveBeenCalledWith('target', 0, { sid: result.sid, impersonatedBy: 'admin-1' });
  });

  it('sets expiresAt from the refresh TTL', async () => {
    const { authSessions, signAccessToken, db } = setup();
    await issueSession('user-1', { createdVia: 'otc', tokenVersion: 0, refreshTtlMs: 1000 }, { db, signAccessToken });
    const created = authSessions.create.mock.calls[0][0] as { expiresAt: Date; lastUsedAt: Date };
    expect(created.expiresAt.getTime()).toBeGreaterThan(created.lastUsedAt.getTime());
    expect(created.expiresAt.getTime() - created.lastUsedAt.getTime()).toBe(1000);
  });
});
