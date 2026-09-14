import { describe, it, expect } from 'vitest';
import { oauthGrantRepository } from './OAuthGrantModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

describe('OAuthGrantModel repository', () => {
  it('upsertGrant creates then updates a single (user,client) row', async () => {
    const created = await oauthGrantRepository.upsertGrant({
      userId: 'u1',
      clientId: 'c1',
      scopes: ['openid'],
      source: 'authorize',
    });
    expect(created?.scopes).toEqual(['openid']);

    const widened = await oauthGrantRepository.upsertGrant({
      userId: 'u1',
      clientId: 'c1',
      scopes: ['openid', 'profile'],
      source: 'authorize',
    });
    expect(widened?.id).toBe(created?.id); // same row, not a duplicate
    expect(widened?.scopes).toEqual(['openid', 'profile']);
  });

  it('findGrant returns the active grant and null for an unknown pair', async () => {
    await oauthGrantRepository.upsertGrant({ userId: 'u2', clientId: 'c2', scopes: ['email'], source: 'authorize' });
    expect((await oauthGrantRepository.findGrant('u2', 'c2'))?.scopes).toEqual(['email']);
    expect(await oauthGrantRepository.findGrant('u2', 'nope')).toBeNull();
  });

  it('revoke hides the grant from findGrant until re-consented', async () => {
    await oauthGrantRepository.upsertGrant({ userId: 'u3', clientId: 'c3', scopes: ['openid'], source: 'authorize' });
    await oauthGrantRepository.revoke('u3', 'c3');
    expect(await oauthGrantRepository.findGrant('u3', 'c3')).toBeNull();

    // A fresh consent clears the revocation and the grant is active again.
    await oauthGrantRepository.upsertGrant({ userId: 'u3', clientId: 'c3', scopes: ['openid'], source: 'authorize' });
    expect((await oauthGrantRepository.findGrant('u3', 'c3'))?.scopes).toEqual(['openid']);
  });
});
