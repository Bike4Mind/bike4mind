import { describe, it, expect } from 'vitest';
import { oauthRefreshTokenRepository } from './OAuthRefreshTokenModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const DAY = 24 * 60 * 60 * 1000;

const seed = (familyId: string, overrides: Record<string, unknown> = {}) =>
  oauthRefreshTokenRepository.create({
    familyId,
    userId: 'u1',
    clientId: 'c1',
    scopes: ['openid', 'offline_access'],
    tokenHash: 'h0',
    tokenVersion: 0,
    expiresAt: new Date(Date.now() + DAY),
    ...overrides,
  });

describe('OAuthRefreshTokenModel repository', () => {
  it('rotate is a compare-and-swap: of two concurrent rotations exactly one wins', async () => {
    await seed('f1');
    const next = { expectedHash: 'h0', newExpiresAt: new Date(Date.now() + 2 * DAY) };
    const results = await Promise.all([
      oauthRefreshTokenRepository.rotate('f1', { ...next, nextHash: 'hA' }),
      oauthRefreshTokenRepository.rotate('f1', { ...next, nextHash: 'hB' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    // The superseded hash no longer matches.
    expect(await oauthRefreshTokenRepository.rotate('f1', { ...next, nextHash: 'hC' })).toBeNull();
  });

  it('rotate rejects a revoked or expired family', async () => {
    await seed('revoked', { revokedAt: new Date() });
    await seed('expired', { expiresAt: new Date(Date.now() - 1000) });
    const params = { expectedHash: 'h0', nextHash: 'h1', newExpiresAt: new Date(Date.now() + DAY) };
    expect(await oauthRefreshTokenRepository.rotate('revoked', params)).toBeNull();
    expect(await oauthRefreshTokenRepository.rotate('expired', params)).toBeNull();
  });

  it('revokeFamily stamps revokedAt', async () => {
    await seed('f2');
    await oauthRefreshTokenRepository.revokeFamily('f2');
    expect((await oauthRefreshTokenRepository.findByFamilyId('f2'))?.revokedAt).toBeInstanceOf(Date);
  });

  it('revokeAllForGrant revokes only that (user, client) pair', async () => {
    await seed('a1');
    await seed('a2');
    await seed('other-client', { clientId: 'c2' });
    await seed('other-user', { userId: 'u2' });

    await oauthRefreshTokenRepository.revokeAllForGrant('u1', 'c1');

    const revoked = async (id: string) => (await oauthRefreshTokenRepository.findByFamilyId(id))?.revokedAt;
    expect(await revoked('a1')).toBeInstanceOf(Date);
    expect(await revoked('a2')).toBeInstanceOf(Date);
    expect(await revoked('other-client')).toBeNull();
    expect(await revoked('other-user')).toBeNull();
  });
});
