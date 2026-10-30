import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateOne } = vi.hoisted(() => ({ updateOne: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ OAuthClientModel: { updateOne } }));

import migration, {
  NATIVE_OAUTH_CLIENT_ID,
  NATIVE_OAUTH_REDIRECT_URI,
} from './20260921236950_ensure-first-party-native-oauth-client';

describe('ensure-first-party-native-oauth-client', () => {
  beforeEach(() => updateOne.mockReset());

  it('upserts the public first-party client insert-only, so operator edits survive a re-run', async () => {
    await migration.up();

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter).toEqual({ clientId: 'b4m-ios-app' });
    expect(options).toEqual({ upsert: true });
    expect(Object.keys(update)).toEqual(['$setOnInsert']);
    expect(update.$setOnInsert).toMatchObject({
      clientId: NATIVE_OAUTH_CLIENT_ID,
      clientType: 'first-party',
      tokenEndpointAuthMethod: 'none',
      redirectUris: ['https://app.bike4mind.com/ios/auth-callback'],
      isActive: true,
    });
    expect(NATIVE_OAUTH_REDIRECT_URI).toBe('https://app.bike4mind.com/ios/auth-callback');
    expect(update.$setOnInsert.clientSecretHash).toEqual(expect.any(String));
  });
});
