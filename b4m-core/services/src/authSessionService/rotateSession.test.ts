import { describe, it, expect, vi } from 'vitest';
import { TooManyRequestsError, UnauthorizedError } from '@bike4mind/utils';
import { rotateSession, type RotateSessionResult } from './rotateSession';
import { buildRefreshToken, generateRefreshSecret, hashRefreshSecret, parseRefreshToken } from './refreshTokenFormat';
import { createMockAuthSessionRepository, createMockUserRepository } from '../__tests__/utils/testUtils';
import { DEFAULT_REFRESH_TTL_MS } from './constants';

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
  authSessions.recoverRotateHash.mockImplementation(async () => makeSession());
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
      newExpiresAt: expect.any(Date),
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

  describe('recovery rotation (lost rotation response)', () => {
    it('rotates forward from the previous hash after the grace window closes', async () => {
      const { authSessions, db, signAccessToken } = setup();
      const held = generateRefreshSecret();
      authSessions.findBySid.mockResolvedValue(
        makeSession({
          refreshTokenHash: 'orphaned-successor',
          previousRefreshTokenHash: hashRefreshSecret(held),
          graceExpiresAt: past(),
        })
      );

      const result = await rotateSession(buildRefreshToken(SID, held), { db, signAccessToken });

      expect(result.status).toBe('rotated');
      expect(secretOf(result)).not.toBe(held);
      expect(authSessions.recoverRotateHash).toHaveBeenCalledWith(SID, {
        expectedPreviousHash: hashRefreshSecret(held),
        nextHash: expect.any(String),
        replayExpiresAt: expect.any(Date),
        newExpiresAt: expect.any(Date),
      });
      expect(authSessions.revokeBySid).not.toHaveBeenCalled();
    });

    it('coalesces when the recovery CAS loses to a sibling that re-opened the window', async () => {
      const { authSessions, db, signAccessToken } = setup();
      const held = generateRefreshSecret();
      const heldHash = hashRefreshSecret(held);
      authSessions.findBySid
        .mockResolvedValueOnce(
          makeSession({ refreshTokenHash: 'orphaned', previousRefreshTokenHash: heldHash, graceExpiresAt: past() })
        )
        // Re-read after the lost CAS: the winner recovered and re-opened the grace window.
        .mockResolvedValueOnce(
          makeSession({ refreshTokenHash: 'recovered', previousRefreshTokenHash: heldHash, graceExpiresAt: future() })
        );
      authSessions.recoverRotateHash.mockResolvedValue(null);

      const result = await rotateSession(buildRefreshToken(SID, held), { db, signAccessToken });

      expect(result.status).toBe('coalesced');
      expect(authSessions.revokeBySid).not.toHaveBeenCalled();
    });

    it('still revokes an unknown secret as theft', async () => {
      const { authSessions, db, signAccessToken } = setup();
      authSessions.findBySid.mockResolvedValue(
        makeSession({ refreshTokenHash: 'cur', previousRefreshTokenHash: 'prev', graceExpiresAt: past() })
      );
      await expect(
        rotateSession(buildRefreshToken(SID, generateRefreshSecret()), { db, signAccessToken })
      ).rejects.toThrow(UnauthorizedError);
      expect(authSessions.revokeBySid).toHaveBeenCalledWith(SID);
      expect(authSessions.recoverRotateHash).not.toHaveBeenCalled();
    });
  });

  describe('sliding session expiry', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('slides a young session to now + DEFAULT_REFRESH_TTL_MS on rotation', async () => {
      const { authSessions, db, signAccessToken } = setup();
      const secret = generateRefreshSecret();
      authSessions.findBySid.mockResolvedValue(
        makeSession({ refreshTokenHash: hashRefreshSecret(secret), createdAt: new Date(), expiresAt: future() })
      );
      await rotateSession(buildRefreshToken(SID, secret), { db, signAccessToken });
      const params = authSessions.rotateHash.mock.calls[0][1] as { newExpiresAt?: Date };
      expect(Math.abs(params.newExpiresAt!.getTime() - (Date.now() + DEFAULT_REFRESH_TTL_MS))).toBeLessThan(5000);
    });

    it('never slides past createdAt + ABSOLUTE_SESSION_MAX_MS, and never shrinks the current expiry', async () => {
      const { authSessions, db, signAccessToken } = setup();
      const secret = generateRefreshSecret();
      const expiresAt = new Date(Date.now() + 10 * DAY);
      authSessions.findBySid.mockResolvedValue(
        makeSession({
          refreshTokenHash: hashRefreshSecret(secret),
          createdAt: new Date(Date.now() - 89 * DAY), // day 89 of 90: the cap is closer than the slide
          expiresAt,
        })
      );
      await rotateSession(buildRefreshToken(SID, secret), { db, signAccessToken });
      const params = authSessions.rotateHash.mock.calls[0][1] as { newExpiresAt?: Date };
      // min(now+30d, createdAt+90d) = ~now+1d, but the row already promised now+10d - keep it.
      expect(params.newExpiresAt!.getTime()).toBe(expiresAt.getTime());
    });
  });

  describe('audit hook', () => {
    it('emits session_reuse_revoked on theft detection', async () => {
      const { authSessions, db, signAccessToken } = setup();
      const audit = vi.fn();
      authSessions.findBySid.mockResolvedValue(
        makeSession({ refreshTokenHash: 'cur', previousRefreshTokenHash: null })
      );
      await expect(
        rotateSession(buildRefreshToken(SID, generateRefreshSecret()), { db, signAccessToken, audit })
      ).rejects.toThrow(UnauthorizedError);
      expect(audit).toHaveBeenCalledWith({ type: 'session_reuse_revoked', sid: SID, userId: 'user-1' });
    });

    it('emits session_recovered on a recovery rotation', async () => {
      const { authSessions, db, signAccessToken } = setup();
      const audit = vi.fn();
      const held = generateRefreshSecret();
      authSessions.findBySid.mockResolvedValue(
        makeSession({
          refreshTokenHash: 'orphaned',
          previousRefreshTokenHash: hashRefreshSecret(held),
          graceExpiresAt: past(),
        })
      );
      await rotateSession(buildRefreshToken(SID, held), { db, signAccessToken, audit });
      expect(audit).toHaveBeenCalledWith({ type: 'session_recovered', sid: SID, userId: 'user-1' });
    });

    it('emits refresh_replay_capped when the coalesce allowance is spent', async () => {
      const { authSessions, db, signAccessToken } = setup();
      const audit = vi.fn();
      const held = generateRefreshSecret();
      authSessions.findBySid.mockResolvedValue(
        makeSession({
          refreshTokenHash: 'cur',
          previousRefreshTokenHash: hashRefreshSecret(held),
          graceExpiresAt: future(),
        })
      );
      authSessions.registerReplayUse.mockResolvedValue(null);
      await expect(rotateSession(buildRefreshToken(SID, held), { db, signAccessToken, audit })).rejects.toThrow(
        TooManyRequestsError
      );
      expect(audit).toHaveBeenCalledWith({ type: 'refresh_replay_capped', sid: SID, userId: 'user-1' });
    });

    it('a throwing audit hook never fails the refresh', async () => {
      const { authSessions, db, signAccessToken } = setup();
      const audit = vi.fn(() => {
        throw new Error('audit sink down');
      });
      const held = generateRefreshSecret();
      authSessions.findBySid.mockResolvedValue(
        makeSession({
          refreshTokenHash: 'orphaned',
          previousRefreshTokenHash: hashRefreshSecret(held),
          graceExpiresAt: past(),
        })
      );
      const result = await rotateSession(buildRefreshToken(SID, held), { db, signAccessToken, audit });
      expect(result.status).toBe('rotated');
    });
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
        if (params.newExpiresAt) state.expiresAt = params.newExpiresAt;
        return { ...state } as never;
      });
      authSessions.recoverRotateHash.mockImplementation(async (_sid, params) => {
        // Mirrors AuthSessionModel.recoverRotateHash: previous-match AND closed grace window are
        // both part of the FILTER; the winner re-opens the window.
        const now = new Date();
        if (state.revokedAt || state.expiresAt <= now) return null;
        if (state.previousRefreshTokenHash !== params.expectedPreviousHash) return null;
        if (!state.graceExpiresAt || state.graceExpiresAt > now) return null;
        state.refreshTokenHash = params.nextHash;
        state.graceExpiresAt = params.replayExpiresAt;
        state.lastUsedAt = now;
        state.replayUses = 0;
        if (params.newExpiresAt) state.expiresAt = params.newExpiresAt;
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

    it('recovers a session whose rotation response was lost, then rotates normally', async () => {
      const s1 = generateRefreshSecret();
      const t = setupStateful(s1);

      // Refresh 1 rotates server-side, but the response never reaches the client:
      // the cookie jar still holds s1.
      const lost = await rotateSession(buildRefreshToken(SID, s1), { db: t.db, signAccessToken: t.signAccessToken });
      expect(lost.status).toBe('rotated');

      // ~30 minutes later (grace long gone) the client presents s1 again.
      t.state.graceExpiresAt = new Date(Date.now() - 1000);
      const recovered = await rotateSession(buildRefreshToken(SID, s1), {
        db: t.db,
        signAccessToken: t.signAccessToken,
      });
      expect(recovered.status).toBe('rotated');
      expect(t.state.revokedAt).toBeNull();

      // The recovered token is the live chain now.
      const next = await rotateSession(refreshTokenOf(recovered), { db: t.db, signAccessToken: t.signAccessToken });
      expect(next.status).toBe('rotated');

      // And the orphaned token from the lost response is dead: presenting it is theft.
      await expect(
        rotateSession(refreshTokenOf(lost), { db: t.db, signAccessToken: t.signAccessToken })
      ).rejects.toThrow(UnauthorizedError);
    });

    it('concurrent recoveries converge: one rotates, the rest coalesce', async () => {
      const s1 = generateRefreshSecret();
      const t = setupStateful(s1);
      const first = await rotateSession(buildRefreshToken(SID, s1), { db: t.db, signAccessToken: t.signAccessToken });
      expect(first.status).toBe('rotated');
      t.state.graceExpiresAt = new Date(Date.now() - 1000);

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          rotateSession(buildRefreshToken(SID, s1), { db: t.db, signAccessToken: t.signAccessToken })
        )
      );
      expect(results.filter(r => r.status === 'rotated')).toHaveLength(1);
      expect(results.filter(r => r.status === 'coalesced')).toHaveLength(3);
      expect(t.state.revokedAt).toBeNull();
    });

    it('still revokes a two-generations-stale secret (theft is unchanged)', async () => {
      const s1 = generateRefreshSecret();
      const { state, authSessions, db, signAccessToken } = setupStateful(s1);

      // Two DELIVERED rotations: s1 -> s2 -> s3. s1 is now two generations back.
      const r1 = await rotateSession(buildRefreshToken(SID, s1), { db, signAccessToken });
      const r2 = await rotateSession(refreshTokenOf(r1), { db, signAccessToken });
      expect(r2.status).toBe('rotated');

      await expect(rotateSession(buildRefreshToken(SID, s1), { db, signAccessToken })).rejects.toBeInstanceOf(
        UnauthorizedError
      );
      expect(authSessions.revokeBySid).toHaveBeenCalledWith(SID);
      expect(state.revokedAt).not.toBeNull();
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
