import { describe, it, expect } from 'vitest';
import { oauthGrantRepository } from './OAuthGrantModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

describe('OAuthGrantModel repository', () => {
  it('upsertGrant creates one active grant, findActiveGrant returns it', async () => {
    const g = await oauthGrantRepository.upsertGrant('user-1', 'client-1', ['openid', 'email']);
    expect(g.status).toBe('active');
    expect(g.scopes).toEqual(['openid', 'email']);
    expect((await oauthGrantRepository.findActiveGrant('user-1', 'client-1'))?.userId).toBe('user-1');
  });

  it('upsertGrant is idempotent per (user, client) and refreshes scopes', async () => {
    await oauthGrantRepository.upsertGrant('user-2', 'client-1', ['openid']);
    const second = await oauthGrantRepository.upsertGrant('user-2', 'client-1', ['openid', 'profile']);
    expect(second.scopes).toEqual(['openid', 'profile']);
    // still exactly one grant for the pair (unique index holds)
    const all = await (oauthGrantRepository as any).model.find({ userId: 'user-2', clientId: 'client-1' });
    expect(all).toHaveLength(1);
  });

  it('revokeGrant makes findActiveGrant miss; re-authorize reactivates', async () => {
    await oauthGrantRepository.upsertGrant('user-3', 'client-1', ['openid']);
    await oauthGrantRepository.revokeGrant('user-3', 'client-1', 'admin-x');
    expect(await oauthGrantRepository.findActiveGrant('user-3', 'client-1')).toBeFalsy();

    const reauth = await oauthGrantRepository.upsertGrant('user-3', 'client-1', ['openid']);
    expect(reauth.status).toBe('active');
    expect(reauth.revokedAt).toBeUndefined();
    expect(await oauthGrantRepository.findActiveGrant('user-3', 'client-1')).toBeTruthy();
  });

  it('grants for different (user, client) pairs are independent', async () => {
    await oauthGrantRepository.upsertGrant('user-4', 'client-1', []);
    await oauthGrantRepository.upsertGrant('user-4', 'client-2', []);
    await oauthGrantRepository.revokeGrant('user-4', 'client-1');
    expect(await oauthGrantRepository.findActiveGrant('user-4', 'client-1')).toBeFalsy();
    expect(await oauthGrantRepository.findActiveGrant('user-4', 'client-2')).toBeTruthy();
  });
});
