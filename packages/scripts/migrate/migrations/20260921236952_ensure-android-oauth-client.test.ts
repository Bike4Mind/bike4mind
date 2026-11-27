import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { updateOne } = vi.hoisted(() => ({ updateOne: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ OAuthClientModel: { updateOne } }));

import { ANDROID_OAUTH_CLIENT_ID } from '@bike4mind/common';
import migration from './20260921236952_ensure-android-oauth-client';

const PROD_REDIRECT_URI = 'https://app.bike4mind.com/android/auth-callback';

describe('ensure-android-oauth-client', () => {
  beforeEach(() => {
    updateOne.mockReset();
    vi.stubEnv('APP_URL', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('upserts the public first-party client insert-only with only the https App Link redirect', async () => {
    await migration.up();

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter).toEqual({ clientId: 'b4m-android-app' });
    expect(options).toEqual({ upsert: true });
    expect(Object.keys(update)).toEqual(['$setOnInsert']);
    expect(update.$setOnInsert).toMatchObject({
      clientId: ANDROID_OAUTH_CLIENT_ID,
      clientType: 'first-party',
      tokenEndpointAuthMethod: 'none',
      allowedScopes: ['openid', 'email', 'profile'],
      redirectUris: [PROD_REDIRECT_URI],
      isActive: true,
    });
    expect(update.$setOnInsert.clientSecretHash).toEqual(expect.any(String));
  });

  it('adds the deploy-origin App Link on a non-prod deploy and never a custom scheme', async () => {
    vi.stubEnv('APP_URL', 'https://pr-1.preview.example.com/');

    await migration.up();

    const { redirectUris } = updateOne.mock.calls[0][1].$setOnInsert;
    expect(redirectUris).toEqual(['https://pr-1.preview.example.com/android/auth-callback', PROD_REDIRECT_URI]);
    expect(redirectUris.every((uri: string) => uri.startsWith('https://'))).toBe(true);
  });
});
