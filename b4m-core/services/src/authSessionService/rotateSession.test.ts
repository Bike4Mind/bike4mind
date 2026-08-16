import { describe, it, expect, vi } from 'vitest';
import { TooManyRequestsError, UnauthorizedError } from '@bike4mind/utils';
import { rotateSession, type RotateSessionResult } from './rotateSession';
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
  authSessions.registerReplayUse.mockImplementation(async () => makeSession());
  authSessions.revokeBySid.mockResolvedValue(makeSession({ revokedAt: new Date() }));
  const signAccessToken = vi.fn().mockReturnValue('ACCESS');
  return { authSessions, users, signAccessToken, db: { authSessions, users } };
};

const refreshTokenOf = (result: RotateSessionResult): string => {
  if (result.status !== 'rotated') throw new Error(`expected a rotation, got ${result.status}`);
  return result.refreshToken;
};
const secretOf = (result: RotateSessionResult): string => parseRefreshToken(refreshTokenOf(result))!.secret;

describe('rotateSession', () => {
  it('rotates on a current-hash match and returns a fresh opaque token + access token', async () => {
    const { authSessions, signAccessToken, db } = setup();
    const secret = generateRefreshSecret();
    authSessions.findBySid.mockResolvedValue(makeSession({ refreshTokenHash: hashRefreshSecret(secret) }));

    const result = await rotateSession(buildRefreshToken(SID, secret), { db, signAccessToken });

    expect(result.status).toBe('rotated');
    // New refresh token is opaque, same sid, different secret.
    const parsed = parseRefreshToken(refreshTokenOf(result))!;
    expect(parsed.sid).toBe(SID);
    expect(parsed.secret).not.toBe(secret);
    // The presented hash is the compare-and-swap guard, so only one of N concurrent rotations wins.
    expect(authSessions.rotateHash).toHaveBeenCalledWith(SID, {
      expectedCurrentHash: hashRefreshSecret(secret),
      nextHash: expect.any(String),
      replayExpiresAt: expect.any(Date),
    });
    // access token minted with the user's CURRENT tokenVersion + sid.
    expect(result.accessToken).toBe('ACCESS');
    expect(signAccessToken).toHaveBeenCalledWith('user-1', 7, { sid: SID });
  });

  it('coalesces (access token only, no rotation) on a previous-hash match inside the replay window', async () => {
    const { authSessions, db, signAccessToken } = setup();
    const oldSecret = generateRefreshSecret();
    authSessions.findBySid.mockResolvedValue(
      makeSession({
        refreshTokenHash: hashRefreshSecret(generateRefreshSecret()), // already rotated to something else
        previousRefreshTokenHash: hashRefreshSecret(oldSecret),
        graceExpiresAt: future(),
      })
    );

    const result = await rotateSession(buildRefreshToken(SID, oldSecret), { db, signAccessToken });

    expect(result.status).toBe('coalesced');
    expect(result).not.toHaveProperty('refreshToken');
    expect(authSessions.revokeBySid).not.toHaveBeenCalled();
    // Not rotating is the point: `previous` stays pinned so every sibling in the burst resolves,
    // and a replayed secret can never be traded for a durable credential.
    expect(authSessions.rotateHash).not.toHaveBeenCalled();
    expect(authSessions.registerReplayUse).toHaveBeenCalledWith(SID, expect.any(Number));
  });

  it('rejects without revoking once the replay allowance for this generation is spent', async () => {
    const { authSessions, db, signAccessToken } = setup();
    const oldSecret = generateRefreshSecret();
    authSessions.findBySid.mockResolvedValue(
      makeSession({
        refreshTokenHash: hashRefreshSecret(generateRefreshSecret()),
        previousRefreshTokenHash: hashRefreshSecret(oldSecret),
        graceExpiresAt: future(),
      })
    );
    authSessions.registerReplayUse.mockResolvedValue(null); // allowance exhausted

    // 429, NOT 401: the client's interceptor reads 400/401 from the refresh endpoint as a
    // revocation and tears the session down, so answering an overrun burst with Unauthorized would
    // log the user out - the exact failure this change exists to remove, one step removed.
    await expect(rotateSession(buildRefreshToken(SID, oldSecret), { db, signAccessToken })).rejects.toBeInstanceOf(
      TooManyRequestsError
    );
    // And not revoked either: a large legitimate burst and abuse are indistinguishable here.
    expect(authSessions.revokeBySid).not.toHaveBeenCalled();
  });

  it('still serves a coalesced refresh when the allowance write is unreachable', async () => {
    // N-1 of N concurrent siblings take this path during exactly the burst this change exists to
    // survive. A transient Mongo error on a bookkeeping write must not fail an otherwise-good
    // refresh - only a definitive "allowance spent" answer may.
    const { authSessions, db, signAccessToken } = setup();
    const oldSecret = generateRefreshSecret();
    authSessions.findBySid.mockResolvedValue(
      makeSession({
        refreshTokenHash: hashRefreshSecret(generateRefreshSecret()),
        previousRefreshTokenHash: hashRefreshSecret(oldSecret),
        graceExpiresAt: future(),
      })
    );
    authSessions.registerReplayUse.mockRejectedValue(new Error('connection reset'));

    const result = await rotateSession(buildRefreshToken(SID, oldSecret), { db, signAccessToken });

    expect(result.status).toBe('coalesced');
    expect(result.accessToken).toBe('ACCESS');
    expect(authSessions.revokeBySid).not.toHaveBeenCalled();
  });

  it('rejects + revokes when the previous hash is presented AFTER the replay window (reuse)', async () => {
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

  /**
   * A stateful row with a REAL compare-and-swap, plus the constraint the old suite was missing: a
   * browser has ONE cookie jar shared by every tab, so of N refresh tokens minted for one session
   * only the last response to land survives. Modelling each caller as keeping its own issued token
   * hides the entire bug class this behaviour exists to prevent.
   */
  describe('concurrency (real CAS + one shared cookie jar)', () => {
    const setupStateful = (initialSecret: string) => {
      const state = makeSession({ refreshTokenHash: hashRefreshSecret(initialSecret) }) as unknown as {
        refreshTokenHash: string;
        previousRefreshTokenHash: string | null;
        graceExpiresAt: Date | null;
        revokedAt: Date | null;
        expiresAt: Date;
        lastUsedAt: Date;
        replayUses?: number;
      };
      const authSessions = createMockAuthSessionRepository();
      const users = createMockUserRepository();
      users.findById.mockResolvedValue({ id: 'user-1', tokenVersion: 7 } as never);
      // Snapshot on read, exactly like a real find: a concurrent writer must not mutate what an
      // in-flight caller already read.
      authSessions.findBySid.mockImplementation(async () => ({ ...state }) as never);
      authSessions.rotateHash.mockImplementation(async (_sid, params) => {
        // Mirrors AuthSessionModel.rotateHash: the expected hash is part of the FILTER.
        if (state.revokedAt || state.expiresAt <= new Date()) return null;
        if (state.refreshTokenHash !== params.expectedCurrentHash) return null; // lost the CAS
        state.refreshTokenHash = params.nextHash;
        state.previousRefreshTokenHash = params.expectedCurrentHash;
        state.graceExpiresAt = params.replayExpiresAt;
        state.lastUsedAt = new Date();
        state.replayUses = 0; // a fresh generation gets a fresh allowance
        return { ...state } as never;
      });
      authSessions.registerReplayUse.mockImplementation(async (_sid, maxUses) => {
        // Mirrors AuthSessionModel.registerReplayUse: the cap is part of the FILTER.
        if (state.revokedAt || state.expiresAt <= new Date()) return null;
        if ((state.replayUses ?? 0) >= maxUses) return null;
        state.replayUses = (state.replayUses ?? 0) + 1;
        state.lastUsedAt = new Date();
        return { ...state } as never;
      });
      authSessions.revokeBySid.mockImplementation(async () => {
        state.revokedAt = new Date();
        return { ...state } as never;
      });
      const signAccessToken = vi.fn().mockReturnValue('ACCESS');
      return { state, authSessions, users, signAccessToken, db: { authSessions, users } };
    };

    /** Apply responses to the single cookie jar in the given landing order; last write wins. */
    const settleCookieJar = (initial: string, results: RotateSessionResult[]): string =>
      results.reduce((cookie, r) => (r.status === 'rotated' ? r.refreshToken : cookie), initial);

    it('mints exactly one refresh token when N tabs refresh the same cookie at once', async () => {
      const s1 = generateRefreshSecret();
      const { authSessions, db, signAccessToken } = setupStateful(s1);
      const token = buildRefreshToken(SID, s1);

      const results = await Promise.all(Array.from({ length: 4 }, () => rotateSession(token, { db, signAccessToken })));

      // Every sibling gets a usable access token...
      expect(results.every(r => r.accessToken === 'ACCESS')).toBe(true);
      // ...but only one advanced the chain, so there is only ever one token to keep.
      expect(results.filter(r => r.status === 'rotated')).toHaveLength(1);
      expect(results.filter(r => r.status === 'coalesced')).toHaveLength(3);
      expect(authSessions.revokeBySid).not.toHaveBeenCalled();
    });

    it.each([
      ['winner last', (r: RotateSessionResult[]) => r],
      ['winner first', (r: RotateSessionResult[]) => [...r].reverse()],
    ])('survives a 30-minute-later refresh regardless of response landing order (%s)', async (_label, order) => {
      const s1 = generateRefreshSecret();
      const { state, authSessions, db, signAccessToken } = setupStateful(s1);
      const token = buildRefreshToken(SID, s1);

      const results = await Promise.all([
        rotateSession(token, { db, signAccessToken }),
        rotateSession(token, { db, signAccessToken }),
        rotateSession(token, { db, signAccessToken }),
      ]);
      const cookie = settleCookieJar(token, order(results));

      // The replay window lapses long before the 30m access token expires. This is the exact
      // moment the old implementation revoked a healthy session.
      state.graceExpiresAt = past();

      const later = await rotateSession(cookie, { db, signAccessToken });
      expect(later.status).toBe('rotated');
      expect(authSessions.revokeBySid).not.toHaveBeenCalled();
      expect(state.revokedAt).toBeNull();
    });

    it('keeps converging across many concurrent refresh cycles', async () => {
      const s1 = generateRefreshSecret();
      const { state, authSessions, db, signAccessToken } = setupStateful(s1);
      let cookie = buildRefreshToken(SID, s1);

      for (let cycle = 0; cycle < 10; cycle++) {
        const results = await Promise.all([
          rotateSession(cookie, { db, signAccessToken }),
          rotateSession(cookie, { db, signAccessToken }),
        ]);
        cookie = settleCookieJar(cookie, results);
        // Whatever the jar kept must be the row's live secret, cycle after cycle.
        expect(parseRefreshToken(cookie)).not.toBeNull();
        expect(hashRefreshSecret(parseRefreshToken(cookie)!.secret)).toBe(state.refreshTokenHash);
        state.graceExpiresAt = past(); // 30 minutes pass between cycles
      }
      expect(authSessions.revokeBySid).not.toHaveBeenCalled();
    });

    it('still revokes a genuinely stale secret replayed after the window (theft is unchanged)', async () => {
      const s1 = generateRefreshSecret();
      const { state, authSessions, db, signAccessToken } = setupStateful(s1);

      const rotated = await rotateSession(buildRefreshToken(SID, s1), { db, signAccessToken });
      expect(secretOf(rotated)).not.toBe(s1);
      state.graceExpiresAt = past();

      await expect(rotateSession(buildRefreshToken(SID, s1), { db, signAccessToken })).rejects.toBeInstanceOf(
        UnauthorizedError
      );
      expect(authSessions.revokeBySid).toHaveBeenCalledWith(SID);
    });

    it('rejects without revoking when the session is revoked between the read and the CAS', async () => {
      const s1 = generateRefreshSecret();
      const { state, authSessions, db, signAccessToken } = setupStateful(s1);
      authSessions.rotateHash.mockImplementationOnce(async () => {
        state.revokedAt = new Date(); // revoked underneath us (e.g. a concurrent per-device logout)
        return null;
      });

      await expect(rotateSession(buildRefreshToken(SID, s1), { db, signAccessToken })).rejects.toBeInstanceOf(
        UnauthorizedError
      );
      // A lost CAS on a dead session is not theft - don't re-revoke, and don't mistake it for reuse.
      expect(authSessions.revokeBySid).not.toHaveBeenCalled();
    });
  });
});
