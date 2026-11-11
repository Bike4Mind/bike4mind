import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateOne } = vi.hoisted(() => ({ updateOne: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ OAuthClientModel: { updateOne } }));

import migration, { NATIVE_OAUTH_DEV_REDIRECT_URI } from './20260921236951_add-native-oauth-dev-redirect-uri';
import seed from './20260921236950_ensure-first-party-native-oauth-client';

describe('add-native-oauth-dev-redirect-uri', () => {
  beforeEach(() => updateOne.mockReset());

  it('adds the custom-scheme redirect to the existing native client without upserting', async () => {
    await migration.up();

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter).toEqual({ clientId: 'b4m-ios-app' });
    expect(update).toEqual({ $addToSet: { redirectUris: 'com.bike4mind.app://auth-callback' } });
    expect(options).toBeUndefined();
  });

  it('down removes only that redirect', async () => {
    await migration.down();

    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ clientId: 'b4m-ios-app' });
    expect(update).toEqual({ $pull: { redirectUris: NATIVE_OAUTH_DEV_REDIRECT_URI } });
  });

  it('runs after the migration that seeds the client', () => {
    expect(migration.id).toBeGreaterThan(seed.id);
  });
});
