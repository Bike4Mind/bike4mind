import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { updateOne } = vi.hoisted(() => ({ updateOne: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ OAuthClientModel: { updateOne } }));

import { NATIVE_DEV_OAUTH_CLIENT_ID, NATIVE_OAUTH_CLIENT_ID } from '@bike4mind/common';
import migration, {
  NATIVE_DEV_OAUTH_REDIRECT_URI,
  shouldSeedNativeDevClient,
} from './20260921236951_ensure-native-dev-oauth-client';
import seed from './20260921236950_ensure-first-party-native-oauth-client';

describe('ensure-native-dev-oauth-client', () => {
  beforeEach(() => {
    updateOne.mockReset();
    vi.stubEnv('SEED_STAGE_NAME', '');
    vi.stubEnv('STAGE', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('seeds a separate first-party client on the custom-scheme redirect, insert-only', async () => {
    vi.stubEnv('SEED_STAGE_NAME', 'dev');
    await migration.up();

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter).toEqual({ clientId: 'b4m-ios-app-dev' });
    expect(options).toEqual({ upsert: true });
    expect(Object.keys(update)).toEqual(['$setOnInsert']);
    expect(update.$setOnInsert).toMatchObject({
      clientId: NATIVE_DEV_OAUTH_CLIENT_ID,
      redirectUris: ['com.bike4mind.app://auth-callback'],
      clientType: 'first-party',
      tokenEndpointAuthMethod: 'none',
      isActive: true,
    });
    expect(NATIVE_DEV_OAUTH_CLIENT_ID).not.toBe(NATIVE_OAUTH_CLIENT_ID);
    expect(NATIVE_DEV_OAUTH_REDIRECT_URI).toBe('com.bike4mind.app://auth-callback');
  });

  it.each([
    ['production', false],
    ['', false],
    ['  ', false],
    ['dev', true],
    ['pr7200', true],
    ['alice', true],
  ])('stage %j seeds: %s', (stage, expected) => {
    expect(shouldSeedNativeDevClient(stage)).toBe(expected);
  });

  it('never writes on production', async () => {
    vi.stubEnv('SEED_STAGE_NAME', 'production');
    await migration.up();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('fails closed when no stage is known', async () => {
    await migration.up();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('falls back to STAGE for CLI runs', async () => {
    vi.stubEnv('SEED_STAGE_NAME', undefined as unknown as string);
    vi.stubEnv('STAGE', 'pr1');
    await migration.up();
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it('runs after the first-party native client seed', () => {
    expect(migration.id).toBeGreaterThan(seed.id);
  });
});
