import { describe, it, expect } from 'vitest';
import { authSessionRepository } from './AuthSessionModel';
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
    });
    expect(updated?.refreshTokenHash).toBe('h1');
    expect(updated?.previousRefreshTokenHash).toBe('h0');

    await authSessionRepository.create(base({ sid: 'rot-dead', revokedAt: new Date() }));
    expect(
      await authSessionRepository.rotateHash('rot-dead', {
        expectedCurrentHash: 'hash-0',
        nextHash: 'x',
        replayExpiresAt,
      })
    ).toBeNull();
  });

  it('rotateHash is a compare-and-swap: only the first of two racing rotations applies', async () => {
    await authSessionRepository.create(base({ sid: 'cas', refreshTokenHash: 'h0' }));
    const replayExpiresAt = new Date(Date.now() + 5000);
    const args = { expectedCurrentHash: 'h0', replayExpiresAt };

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

  it('touchLastUsed bumps activity without disturbing the refresh chain', async () => {
    const lastUsedAt = new Date(Date.now() - 60_000);
    await authSessionRepository.create(
      base({ sid: 'touch', refreshTokenHash: 'h0', previousRefreshTokenHash: 'hp', lastUsedAt })
    );
    await authSessionRepository.touchLastUsed('touch');
    const row = await authSessionRepository.findBySid('touch');
    expect(row!.lastUsedAt.getTime()).toBeGreaterThan(lastUsedAt.getTime());
    expect(row?.refreshTokenHash).toBe('h0');
    expect(row?.previousRefreshTokenHash).toBe('hp');
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
});
