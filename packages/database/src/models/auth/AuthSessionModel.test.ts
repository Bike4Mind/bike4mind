import { describe, it, expect } from 'vitest';
import { AuthSessionModel, authSessionRepository } from './AuthSessionModel';

/** rotateHash requires a slid expiry; tests that are not about sliding just need a live value. */
const FAR_FUTURE = () => new Date(Date.now() + 30 * 86_400_000);
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const base = (o: Record<string, unknown> = {}) =>
  ({
    sid: 'sid-x',
    userId: 'user-1',
    refreshTokenHash: 'hash-0',
    previousRefreshTokenHash: null,
    graceExpiresAt: null,
    createdVia: 'otc',
    impersonatedBy: null,
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    ...o,
  }) as never;

describe('AuthSessionModel repository', () => {
  it('findBySid returns the session (or null)', async () => {
    await authSessionRepository.create(base({ sid: 'a' }));
    expect((await authSessionRepository.findBySid('a'))?.userId).toBe('user-1');
    expect(await authSessionRepository.findBySid('missing')).toBeFalsy(); // base repo yields undefined for a miss
  });

  it('findActiveByUserId excludes revoked and expired, newest-used first', async () => {
    await authSessionRepository.create(base({ sid: 'old', userId: 'u2', lastUsedAt: new Date(Date.now() - 1000) }));
    await authSessionRepository.create(base({ sid: 'new', userId: 'u2', lastUsedAt: new Date() }));
    await authSessionRepository.create(base({ sid: 'revoked', userId: 'u2', revokedAt: new Date() }));
    await authSessionRepository.create(base({ sid: 'expired', userId: 'u2', expiresAt: new Date(Date.now() - 1000) }));
    const active = await authSessionRepository.findActiveByUserId('u2');
    expect(active.map(s => s.sid)).toEqual(['new', 'old']);
  });

  it('rotateHash advances the chain and refuses a revoked session', async () => {
    await authSessionRepository.create(base({ sid: 'rot', refreshTokenHash: 'h0' }));
    const replayExpiresAt = new Date(Date.now() + 5000);
    const updated = await authSessionRepository.rotateHash('rot', {
      expectedCurrentHash: 'h0',
      nextHash: 'h1',
      replayExpiresAt,
      newExpiresAt: FAR_FUTURE(),
    });
    expect(updated?.refreshTokenHash).toBe('h1');
    expect(updated?.previousRefreshTokenHash).toBe('h0');

    await authSessionRepository.create(base({ sid: 'rot-dead', revokedAt: new Date() }));
    expect(
      await authSessionRepository.rotateHash('rot-dead', {
        expectedCurrentHash: 'hash-0',
        nextHash: 'x',
        replayExpiresAt,
        newExpiresAt: FAR_FUTURE(),
      })
    ).toBeNull();
  });

  it('rotateHash is a compare-and-swap: only the first of two racing rotations applies', async () => {
    await authSessionRepository.create(base({ sid: 'cas', refreshTokenHash: 'h0' }));
    const replayExpiresAt = new Date(Date.now() + 5000);
    const args = { expectedCurrentHash: 'h0', replayExpiresAt, newExpiresAt: FAR_FUTURE() };

    // Both readers saw h0; issuing two tokens for one generation is exactly what strands a browser
    // cookie jar, so the loser must come back null rather than clobbering the winner.
    const [first, second] = await Promise.all([
      authSessionRepository.rotateHash('cas', { ...args, nextHash: 'h1' }),
      authSessionRepository.rotateHash('cas', { ...args, nextHash: 'h2' }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const row = await authSessionRepository.findBySid('cas');
    expect(['h1', 'h2']).toContain(row?.refreshTokenHash);
    expect(row?.previousRefreshTokenHash).toBe('h0');
  });

  it('registerReplayUse bumps activity without disturbing the refresh chain', async () => {
    const lastUsedAt = new Date(Date.now() - 60_000);
    await authSessionRepository.create(
      base({ sid: 'touch', refreshTokenHash: 'h0', previousRefreshTokenHash: 'hp', lastUsedAt })
    );
    const row = await authSessionRepository.registerReplayUse('touch', 10);
    expect(row!.lastUsedAt.getTime()).toBeGreaterThan(lastUsedAt.getTime());
    expect(row?.refreshTokenHash).toBe('h0');
    expect(row?.previousRefreshTokenHash).toBe('hp');
    expect(row?.replayUses).toBe(1);
  });

  it('registerReplayUse stops handing out replays once the allowance is spent', async () => {
    await authSessionRepository.create(base({ sid: 'cap' }));
    for (let i = 0; i < 3; i++) {
      expect(await authSessionRepository.registerReplayUse('cap', 3)).not.toBeNull();
    }
    // Without this bound the window caps only how LONG a superseded secret can be replayed, not
    // how many access tokens it can mint in that time.
    expect(await authSessionRepository.registerReplayUse('cap', 3)).toBeNull();
  });

  it('registerReplayUse admits rows written before replayUses existed', async () => {
    // Mongoose defaults apply on create, not to documents already in the collection, so a `$lt`
    // filter would silently skip every in-flight session on deploy and reject its refreshes.
    await authSessionRepository.create(base({ sid: 'legacy' }));
    await AuthSessionModel.updateOne({ sid: 'legacy' }, { $unset: { replayUses: '' } }).exec();
    // Assert on the RAW document: Mongoose applies the schema default when hydrating, so a read
    // through the model would report 0 and hide whether the field is really absent - which is the
    // only thing the query filter actually sees.
    const raw = await AuthSessionModel.collection.findOne({ sid: 'legacy' });
    expect(raw && 'replayUses' in raw).toBe(false);

    expect(await authSessionRepository.registerReplayUse('legacy', 10)).not.toBeNull();
    expect((await authSessionRepository.findBySid('legacy'))?.replayUses).toBe(1);
  });

  it('registerReplayUse refuses a revoked or expired session', async () => {
    await authSessionRepository.create(base({ sid: 'rp-revoked', revokedAt: new Date() }));
    await authSessionRepository.create(base({ sid: 'rp-expired', expiresAt: new Date(Date.now() - 1000) }));
    expect(await authSessionRepository.registerReplayUse('rp-revoked', 10)).toBeNull();
    expect(await authSessionRepository.registerReplayUse('rp-expired', 10)).toBeNull();
  });

  it('rotateHash resets the replay allowance for the new generation', async () => {
    await authSessionRepository.create(base({ sid: 'reset', refreshTokenHash: 'h0' }));
    await authSessionRepository.registerReplayUse('reset', 10);
    await authSessionRepository.registerReplayUse('reset', 10);
    expect((await authSessionRepository.findBySid('reset'))?.replayUses).toBe(2);

    await authSessionRepository.rotateHash('reset', {
      expectedCurrentHash: 'h0',
      nextHash: 'h1',
      replayExpiresAt: new Date(Date.now() + 5000),
      newExpiresAt: FAR_FUTURE(),
    });
    expect((await authSessionRepository.findBySid('reset'))?.replayUses).toBe(0);
  });

  it('revokeBySid sets revokedAt exactly once', async () => {
    await authSessionRepository.create(base({ sid: 'rev' }));
    expect((await authSessionRepository.revokeBySid('rev'))?.revokedAt).toBeTruthy();
    expect(await authSessionRepository.revokeBySid('rev')).toBeNull(); // already revoked
  });

  it('revokeAllByUserId revokes all active (honoring exceptSid) and returns the count', async () => {
    await authSessionRepository.create(base({ sid: 'm1', userId: 'u3' }));
    await authSessionRepository.create(base({ sid: 'm2', userId: 'u3' }));
    await authSessionRepository.create(base({ sid: 'keep', userId: 'u3' }));
    expect(await authSessionRepository.revokeAllByUserId('u3', { exceptSid: 'keep' })).toBe(2);
    expect((await authSessionRepository.findActiveByUserId('u3')).map(s => s.sid)).toEqual(['keep']);
  });

  it('rotateHash writes the slid expiry and clears the recovery allowance', async () => {
    const slid = new Date(Date.now() + 7 * 86_400_000);
    await authSessionRepository.create(base({ sid: 'slide', refreshTokenHash: 'h0', recoveries: 2 }));
    const updated = await authSessionRepository.rotateHash('slide', {
      expectedCurrentHash: 'h0',
      nextHash: 'h1',
      replayExpiresAt: new Date(Date.now() + 5000),
      newExpiresAt: slid,
    });
    expect(updated?.expiresAt.getTime()).toBe(slid.getTime());
    // Possession of the CURRENT secret is the only thing that refills the recovery allowance.
    expect(updated?.recoveries).toBe(0);
  });

  it('recoverRotateHash rotates from the previous hash once its grace window has closed', async () => {
    await authSessionRepository.create(
      base({
        sid: 'rec',
        refreshTokenHash: 'orphaned',
        previousRefreshTokenHash: 'held',
        graceExpiresAt: new Date(Date.now() - 1000),
        replayUses: 3,
      })
    );
    const before = (await authSessionRepository.findBySid('rec'))!.expiresAt.getTime();
    const replayExpiresAt = new Date(Date.now() + 5000);
    const updated = await authSessionRepository.recoverRotateHash('rec', {
      expectedPreviousHash: 'held',
      nextHash: 'recovered',
      replayExpiresAt,
      maxRecoveries: 3,
    });
    expect(updated?.refreshTokenHash).toBe('recovered');
    // Previous stays PINNED so burst siblings still coalesce in the re-opened window instead of
    // forking the chain. Do not "fix" this to advance: that is the property the recovery allowance
    // below exists to bound, not an oversight.
    expect(updated?.previousRefreshTokenHash).toBe('held');
    expect(updated?.graceExpiresAt?.getTime()).toBe(replayExpiresAt.getTime());
    expect(updated?.replayUses).toBe(0); // fresh generation, fresh allowance
    expect(updated?.recoveries).toBe(1); // spends one unit of the recovery allowance
    // A superseded secret must never extend the session it is used against.
    expect(updated?.expiresAt.getTime()).toBe(before);
  });

  it('recoverRotateHash refuses once the recovery allowance is spent', async () => {
    await authSessionRepository.create(
      base({
        sid: 'rec-cap',
        refreshTokenHash: 'orphaned',
        previousRefreshTokenHash: 'held',
        graceExpiresAt: new Date(Date.now() - 1000),
        recoveries: 3,
      })
    );
    expect(
      await authSessionRepository.recoverRotateHash('rec-cap', {
        expectedPreviousHash: 'held',
        nextHash: 'nope',
        replayExpiresAt: new Date(Date.now() + 5000),
        maxRecoveries: 3,
      })
    ).toBeNull();
  });

  it('recoverRotateHash still serves rows written before `recoveries` existed', async () => {
    // `$not: { $gte }` rather than `$lt`: a `$lt` filter silently skips a missing field, which
    // would reject every in-flight session on deploy.
    await authSessionRepository.create(
      base({
        sid: 'rec-legacy',
        refreshTokenHash: 'orphaned',
        previousRefreshTokenHash: 'held',
        graceExpiresAt: new Date(Date.now() - 1000),
      })
    );
    await AuthSessionModel.updateOne({ sid: 'rec-legacy' }, { $unset: { recoveries: '' } }).exec();
    const updated = await authSessionRepository.recoverRotateHash('rec-legacy', {
      expectedPreviousHash: 'held',
      nextHash: 'recovered',
      replayExpiresAt: new Date(Date.now() + 5000),
      maxRecoveries: 3,
    });
    expect(updated?.refreshTokenHash).toBe('recovered');
    expect(updated?.recoveries).toBe(1);
  });

  it('recoverRotateHash refuses while the grace window is still open (coalesce territory)', async () => {
    await authSessionRepository.create(
      base({
        sid: 'rec-open',
        refreshTokenHash: 'orphaned',
        previousRefreshTokenHash: 'held',
        graceExpiresAt: new Date(Date.now() + 60_000),
      })
    );
    expect(
      await authSessionRepository.recoverRotateHash('rec-open', {
        expectedPreviousHash: 'held',
        nextHash: 'nope',
        replayExpiresAt: new Date(Date.now() + 5000),
        maxRecoveries: 3,
      })
    ).toBeNull();
  });

  it('recoverRotateHash refuses a non-previous hash and dead sessions', async () => {
    await authSessionRepository.create(
      base({
        sid: 'rec-wrong',
        refreshTokenHash: 'cur',
        previousRefreshTokenHash: 'held',
        graceExpiresAt: new Date(Date.now() - 1000),
      })
    );
    expect(
      await authSessionRepository.recoverRotateHash('rec-wrong', {
        expectedPreviousHash: 'stolen-two-gens-back',
        nextHash: 'nope',
        replayExpiresAt: new Date(Date.now() + 5000),
        maxRecoveries: 3,
      })
    ).toBeNull();

    await authSessionRepository.create(
      base({
        sid: 'rec-dead',
        refreshTokenHash: 'cur',
        previousRefreshTokenHash: 'held',
        graceExpiresAt: new Date(Date.now() - 1000),
        revokedAt: new Date(),
      })
    );
    expect(
      await authSessionRepository.recoverRotateHash('rec-dead', {
        expectedPreviousHash: 'held',
        nextHash: 'nope',
        replayExpiresAt: new Date(Date.now() + 5000),
        maxRecoveries: 3,
      })
    ).toBeNull();
  });

  it('only the first of two racing recoveries applies (the winner re-opens the grace window)', async () => {
    await authSessionRepository.create(
      base({
        sid: 'rec-race',
        refreshTokenHash: 'orphaned',
        previousRefreshTokenHash: 'held',
        graceExpiresAt: new Date(Date.now() - 1000),
      })
    );
    const params = { expectedPreviousHash: 'held', replayExpiresAt: new Date(Date.now() + 60_000), maxRecoveries: 3 };
    const [a, b] = await Promise.all([
      authSessionRepository.recoverRotateHash('rec-race', { ...params, nextHash: 'r1' }),
      authSessionRepository.recoverRotateHash('rec-race', { ...params, nextHash: 'r2' }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = (a ?? b)!;
    expect(['r1', 'r2']).toContain(winner.refreshTokenHash);
  });
});
