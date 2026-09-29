import { describe, it, expect } from 'vitest';
import { oauthGrantRepository, OAuthGrantModel } from './OAuthGrantModel';
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

  it('upsertGrant unions disjoint scopes instead of overwriting them (no lost update)', async () => {
    await oauthGrantRepository.upsertGrant({ userId: 'u4', clientId: 'c4', scopes: ['openid'], source: 'authorize' });
    // A second consent approving a *different* scope must widen, not replace: a $set of ['email']
    // would drop 'openid' (the lost-update race two tabs could trigger).
    const widened = await oauthGrantRepository.upsertGrant({
      userId: 'u4',
      clientId: 'c4',
      scopes: ['email'],
      source: 'authorize',
    });
    expect(widened?.scopes).toEqual(expect.arrayContaining(['openid', 'email']));
    expect(widened?.scopes).toHaveLength(2);
  });

  it('upsertGrant folds concurrent initial consents into one row instead of throwing', async () => {
    // The E11000 retry only fires when the unique (clientId, userId) index exists; setupMongoTest
    // drops the DB (and its indexes) before each test and does not build this model's, so build it
    // here. In production the ensure-oauthgrant-client-user-index migration does this.
    await OAuthGrantModel.ensureIndexes();
    // Both start from no grant and race the upsert insert; the unique index lets one win and the
    // other retries as an update. The single surviving row must carry both scopes.
    const [a, b] = await Promise.all([
      oauthGrantRepository.upsertGrant({ userId: 'u5', clientId: 'c5', scopes: ['email'], source: 'authorize' }),
      oauthGrantRepository.upsertGrant({ userId: 'u5', clientId: 'c5', scopes: ['profile'], source: 'authorize' }),
    ]);
    expect(a?.id).toBe(b?.id); // one row, not a duplicate
    const grant = await oauthGrantRepository.findGrant('u5', 'c5');
    expect(grant?.scopes).toEqual(expect.arrayContaining(['email', 'profile']));
    expect(grant?.scopes).toHaveLength(2);
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

  it('revoke returns null for an already-revoked grant instead of re-stamping revokedAt', async () => {
    await oauthGrantRepository.upsertGrant({ userId: 'u8', clientId: 'c8', scopes: ['openid'], source: 'authorize' });
    const first = await oauthGrantRepository.revoke('u8', 'c8');
    expect(first).not.toBeNull();
    // A second revoke on an already-revoked grant must return null, not update the timestamp.
    const second = await oauthGrantRepository.revoke('u8', 'c8');
    expect(second).toBeNull();
  });

  it('listActiveByUser returns only non-revoked grants for that user', async () => {
    await oauthGrantRepository.upsertGrant({ userId: 'u6', clientId: 'c6a', scopes: ['openid'], source: 'authorize' });
    await oauthGrantRepository.upsertGrant({ userId: 'u6', clientId: 'c6b', scopes: ['profile'], source: 'authorize' });
    // Revoke one; only the active grant should be listed.
    await oauthGrantRepository.revoke('u6', 'c6a');

    const active = await oauthGrantRepository.listActiveByUser('u6');
    expect(active).toHaveLength(1);
    expect(active[0].clientId).toBe('c6b');
  });

  it('listActiveByUser returns an empty array when the user has no active grants', async () => {
    const active = await oauthGrantRepository.listActiveByUser('u-nobody');
    expect(active).toEqual([]);
  });

  it('listActiveByUser does not return grants belonging to a different user', async () => {
    await oauthGrantRepository.upsertGrant({ userId: 'u7', clientId: 'c7', scopes: ['email'], source: 'authorize' });
    const active = await oauthGrantRepository.listActiveByUser('u-other');
    expect(active).toHaveLength(0);
  });
});
