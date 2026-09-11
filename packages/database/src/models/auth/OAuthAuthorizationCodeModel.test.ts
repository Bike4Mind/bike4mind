import { describe, it, expect } from 'vitest';
import { oauthAuthorizationCodeRepository } from './OAuthAuthorizationCodeModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const base = (o: Record<string, unknown> = {}) =>
  ({
    code: 'code-default',
    clientId: 'client-1',
    userId: 'user-1',
    redirectUri: 'https://app.example/cb',
    scopes: ['openid'],
    expiresAt: new Date(Date.now() + 600_000),
    used: false,
    ...o,
  }) as never;

describe('OAuthAuthorizationCodeModel repository', () => {
  it('consumeValidCode returns the code once, then null (single-use)', async () => {
    await oauthAuthorizationCodeRepository.create(base({ code: 'once' }));
    expect((await oauthAuthorizationCodeRepository.consumeValidCode('once'))?.clientId).toBe('client-1');
    expect(await oauthAuthorizationCodeRepository.consumeValidCode('once')).toBeFalsy();
  });

  it('rejects an expired or unknown code', async () => {
    await oauthAuthorizationCodeRepository.create(base({ code: 'stale', expiresAt: new Date(Date.now() - 1000) }));
    expect(await oauthAuthorizationCodeRepository.consumeValidCode('stale')).toBeFalsy();
    expect(await oauthAuthorizationCodeRepository.consumeValidCode('ghost')).toBeFalsy();
  });

  it('redeems a code at most once under concurrent requests (atomic)', async () => {
    await oauthAuthorizationCodeRepository.create(base({ code: 'race' }));
    const results = await Promise.all([
      oauthAuthorizationCodeRepository.consumeValidCode('race'),
      oauthAuthorizationCodeRepository.consumeValidCode('race'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
