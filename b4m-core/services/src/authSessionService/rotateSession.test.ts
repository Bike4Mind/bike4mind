import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedError } from '@bike4mind/utils';
import { rotateSession } from './rotateSession';
import { buildRefreshToken, generateRefreshSecret, hashRefreshSecret, parseRefreshToken } from './refreshTokenFormat';
import { createMockAuthSessionRepository, createMockUserRepository } from '../__tests__/utils/testUtils';

const SID = 'sid-1';
const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

const makeSession = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'row-1',
    sid: SID,
    userId: 'user-1',
    refreshTokenHash: 'unset',
    previousRefreshTokenHash: null,
    graceExpiresAt: null,
    revokedAt: null,
    expiresAt: future(),
    impersonatedBy: null,
    lastUsedAt: new Date(),
    createdVia: 'otc',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as never;

const setup = () => {
  const authSessions = createMockAuthSessionRepository();
  const users = createMockUserRepository();
  users.findById.mockResolvedValue({ id: 'user-1', tokenVersion: 7 } as never);
  authSessions.rotateHash.mockImplementation(async () => makeSession());
  authSessions.revokeBySid.mockResolvedValue(makeSession({ revokedAt: new Date() }));
  const signAccessToken = vi.fn().mockReturnValue('ACCESS');
  return { authSessions, users, signAccessToken, db: { authSessions, users } };
};

describe('rotateSession', () => {
  it('rotates on a current-hash match and returns a fresh opaque token + access token', async () => {
    const { authSessions, signAccessToken, db } = setup();
    const secret = generateRefreshSecret();
    authSessions.findBySid.mockResolvedValue(makeSession({ refreshTokenHash: hashRefreshSecret(secret) }));

    const result = await rotateSession(buildRefreshToken(SID, secret), { db, signAccessToken });

    // New refresh token is opaque, same sid, different secret.
    const parsed = parseRefreshToken(result.refreshToken)!;
    expect(parsed.sid).toBe(SID);
    expect(parsed.secret).not.toBe(secret);
    // previous := the superseded CURRENT hash (equal to the presented one here, since this is a
    // current-hash match), so the one-generation-back secret stays valid in-window.
    expect(authSessions.rotateHash).toHaveBeenCalledWith(
      SID,
      expect.any(String),
      hashRefreshSecret(secret),
      expect.any(Date)
    );
    // access token minted with the user's CURRENT tokenVersion + sid.
    expect(result.accessToken).toBe('ACCESS');
    expect(signAccessToken).toHaveBeenCalledWith('user-1', 7, { sid: SID });
  });

  it('accepts the previous hash INSIDE the grace window (benign concurrent refresh, no revoke)', async () => {
    const { authSessions, db, signAccessToken } = setup();
    const oldSecret = generateRefreshSecret();
    authSessions.findBySid.mockResolvedValue(
      makeSession({
        refreshTokenHash: hashRefreshSecret(generateRefreshSecret()), // already rotated to something else
        previousRefreshTokenHash: hashRefreshSecret(oldSecret),
        graceExpiresAt: future(),
      })
    );

    await expect(rotateSession(buildRefreshToken(SID, oldSecret), { db, signAccessToken })).resolves.toBeTruthy();
    expect(authSessions.revokeBySid).not.toHaveBeenCalled();
    expect(authSessions.rotateHash).toHaveBeenCalled();
  });

  it('rejects + revokes when the previous hash is presented AFTER the grace window (reuse)', async () => {
    const { authSessions, db, signAccessToken } = setup();
    const oldSecret = generateRefreshSecret();
    authSessions.findBySid.mockResolvedValue(
      makeSession({
        refreshTokenHash: hashRefreshSecret(generateRefreshSecret()),
        previousRefreshTokenHash: hashRefreshSecret(oldSecret),
        graceExpiresAt: past(), // window closed
      })
    );

    await expect(rotateSession(buildRefreshToken(SID, oldSecret), { db, signAccessToken })).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    expect(authSessions.revokeBySid).toHaveBeenCalledWith(SID);
    expect(authSessions.rotateHash).not.toHaveBeenCalled();
  });

  it('rejects + revokes on an unknown secret (theft/replay)', async () => {
    const { authSessions, db, signAccessToken } = setup();
    authSessions.findBySid.mockResolvedValue(makeSession({ refreshTokenHash: hashRefreshSecret('the-real-one') }));

    await expect(
      rotateSession(buildRefreshToken(SID, generateRefreshSecret()), { db, signAccessToken })
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authSessions.revokeBySid).toHaveBeenCalledWith(SID);
  });

  it('rejects a revoked session without rotating or re-revoking', async () => {
    const { authSessions, db, signAccessToken } = setup();
    const secret = generateRefreshSecret();
    authSessions.findBySid.mockResolvedValue(
      makeSession({ refreshTokenHash: hashRefreshSecret(secret), revokedAt: new Date() })
    );
    await expect(rotateSession(buildRefreshToken(SID, secret), { db, signAccessToken })).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    expect(authSessions.rotateHash).not.toHaveBeenCalled();
    expect(authSessions.revokeBySid).not.toHaveBeenCalled();
  });

  it('rejects an expired session', async () => {
    const { authSessions, db, signAccessToken } = setup();
    const secret = generateRefreshSecret();
    authSessions.findBySid.mockResolvedValue(
      makeSession({ refreshTokenHash: hashRefreshSecret(secret), expiresAt: past() })
    );
    await expect(rotateSession(buildRefreshToken(SID, secret), { db, signAccessToken })).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    expect(authSessions.rotateHash).not.toHaveBeenCalled();
  });

  it('rejects an unknown sid', async () => {
    const { authSessions, db, signAccessToken } = setup();
    authSessions.findBySid.mockResolvedValue(null);
    await expect(
      rotateSession(buildRefreshToken(SID, generateRefreshSecret()), { db, signAccessToken })
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a non-opaque (legacy JWT) token without a DB lookup', async () => {
    const { authSessions, db, signAccessToken } = setup();
    await expect(rotateSession('header.payload.signature', { db, signAccessToken })).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    expect(authSessions.findBySid).not.toHaveBeenCalled();
  });

  it('rejects when the session user no longer exists', async () => {
    const { authSessions, users, db, signAccessToken } = setup();
    const secret = generateRefreshSecret();
    authSessions.findBySid.mockResolvedValue(makeSession({ refreshTokenHash: hashRefreshSecret(secret) }));
    users.findById.mockResolvedValue(null);
    await expect(rotateSession(buildRefreshToken(SID, secret), { db, signAccessToken })).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  // The single-rotation cases above stub rotateHash to a fresh default session, so they cannot see
  // how `previous`/`current` evolve across a SEQUENCE of rotations. These drive the real rotateSession
  // against a mutable in-memory row -- the only shape that catches an incorrect `previous` anchor.
  describe('rotation sequences (stateful row)', () => {
    type MutableSession = {
      sid: string;
      userId: string;
      refreshTokenHash: string;
      previousRefreshTokenHash: string | null;
      graceExpiresAt: Date | null;
      revokedAt: Date | null;
      expiresAt: Date;
      impersonatedBy: string | null;
    };

    const setupStateful = (initialSecret: string) => {
      const state = makeSession({
        refreshTokenHash: hashRefreshSecret(initialSecret),
      }) as unknown as MutableSession;
      const authSessions = createMockAuthSessionRepository();
      const users = createMockUserRepository();
      users.findById.mockResolvedValue({ id: 'user-1', tokenVersion: 7 } as never);
      authSessions.findBySid.mockImplementation(async () => state as never);
      authSessions.rotateHash.mockImplementation(async (_sid, nextHash, previousHash, graceExpiresAt) => {
        // Mirror AuthSessionModel.rotateHash: scoped to a live row, otherwise no-op (null).
        if (state.revokedAt || state.expiresAt <= new Date()) return null;
        state.refreshTokenHash = nextHash;
        state.previousRefreshTokenHash = previousHash;
        state.graceExpiresAt = graceExpiresAt;
        return state as never;
      });
      authSessions.revokeBySid.mockImplementation(async () => {
        state.revokedAt = new Date();
        return state as never;
      });
      const signAccessToken = vi.fn().mockReturnValue('ACCESS');
      return { state, authSessions, users, signAccessToken, db: { authSessions, users } };
    };

    it('does not revoke when two tabs rotate from the same secret and the first refreshes again', async () => {
      const s1 = generateRefreshSecret();
      const { state, authSessions, db, signAccessToken } = setupStateful(s1);

      // Tab A rotates S1 -> S2.
      const a = await rotateSession(buildRefreshToken(SID, s1), { db, signAccessToken });
      const s2 = parseRefreshToken(a.refreshToken)!.secret;
      // Tab B, still holding S1, rotates inside the grace window -> S3.
      await rotateSession(buildRefreshToken(SID, s1), { db, signAccessToken });
      // Tab A refreshes with the S2 it was legitimately issued: previous must have advanced to S2's
      // predecessor, so this succeeds instead of tripping the theft response.
      await expect(rotateSession(buildRefreshToken(SID, s2), { db, signAccessToken })).resolves.toBeTruthy();
      expect(authSessions.revokeBySid).not.toHaveBeenCalled();
      expect(state.revokedAt).toBeNull();
    });

    it('rejects a second replay of the same superseded secret (grace does not extend indefinitely)', async () => {
      const s1 = generateRefreshSecret();
      const { authSessions, db, signAccessToken } = setupStateful(s1);

      // Rotate S1 -> S2; S1 becomes the one-generation-back grace hash.
      await rotateSession(buildRefreshToken(SID, s1), { db, signAccessToken });
      // First in-window replay of S1 is tolerated (genuine concurrent burst).
      await expect(rotateSession(buildRefreshToken(SID, s1), { db, signAccessToken })).resolves.toBeTruthy();
      // `previous` advanced past S1, so a second replay is now stale reuse -> reject + revoke.
      await expect(rotateSession(buildRefreshToken(SID, s1), { db, signAccessToken })).rejects.toBeInstanceOf(
        UnauthorizedError
      );
      expect(authSessions.revokeBySid).toHaveBeenCalledWith(SID);
    });
  });
});
