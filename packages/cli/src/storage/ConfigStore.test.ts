/**
 * Tests for ConfigStore.switchApiEnvironment
 *
 * Covers the per-environment auth token cache: no-op same-env, stash on switch
 * away, restore on switch back, logout-then-switch dropping the stale cache
 * entry, URL-key normalization, and the expiry-aware authenticated flag.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigStore } from './ConfigStore';
import type { AuthTokens } from './types';
import { getDefaultApiUrl, LOCAL_DEV_URL } from '../utils/apiUrl';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function makeTokens(userId: string, expiresAt: string = FUTURE): AuthTokens {
  return {
    accessToken: `access-${userId}`,
    refreshToken: `refresh-${userId}`,
    expiresAt,
    userId,
  };
}

async function makeTempConfigPath(): Promise<string> {
  const dir = path.join(tmpdir(), `b4m-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, 'config.json');
}

async function cleanup(configPath: string): Promise<void> {
  try {
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('ConfigStore.switchApiEnvironment', () => {
  let configPath: string;
  let store: ConfigStore;

  beforeEach(async () => {
    // Disable project-config discovery so tests aren't influenced by the repo's
    // own .bike4mind/ directory (the test runs inside a git worktree).
    process.env.B4M_NO_PROJECT_CONFIG = '1';
    // The default endpoint is build-time injected (empty in vitest); pin a
    // branded value so the prod-environment assertions exercise a realistic
    // default rather than an empty string.
    process.env.B4M_DEFAULT_API_URL = 'https://app.bike4mind.com';
    configPath = await makeTempConfigPath();
    store = new ConfigStore(configPath);
  });

  afterEach(async () => {
    await cleanup(configPath);
    delete process.env.B4M_NO_PROJECT_CONFIG;
    delete process.env.B4M_DEFAULT_API_URL;
  });

  describe('no-op same-env switch', () => {
    it('returns changed:false and does not mutate authByEnv when target matches current env', async () => {
      // Default config has no customUrl, so already on prod.
      const tokens = makeTokens('prod-user');
      await store.setAuthTokens(tokens);

      const result = await store.switchApiEnvironment('prod');

      expect(result.changed).toBe(false);
      expect(result.url).toBe(getDefaultApiUrl());
      expect(result.authenticated).toBe(true);

      const config = await store.get();
      expect(config.authByEnv).toBeUndefined(); // never touched
      expect(config.auth).toEqual(tokens); // unchanged
    });

    it('returns authenticated:false when current token is expired', async () => {
      const expired = makeTokens('prod-user', PAST);
      await store.setAuthTokens(expired);

      const result = await store.switchApiEnvironment('prod');

      expect(result.changed).toBe(false);
      expect(result.authenticated).toBe(false);
    });
  });

  describe('switching away stashes config.auth', () => {
    it('stashes the active token in authByEnv keyed by the previous URL on switch', async () => {
      const prodTokens = makeTokens('prod-user');
      await store.setAuthTokens(prodTokens);

      const result = await store.switchApiEnvironment('dev');

      expect(result.changed).toBe(true);
      expect(result.url).toBe(LOCAL_DEV_URL);
      expect(result.authenticated).toBe(false); // nothing to restore for dev yet

      const config = await store.get();
      expect(config.apiConfig?.customUrl).toBe(LOCAL_DEV_URL);
      expect(config.authByEnv?.[getDefaultApiUrl()]).toEqual(prodTokens);
      expect(config.auth).toBeUndefined();
    });
  });

  describe('switching back restores from authByEnv', () => {
    it('restores a previously-stashed token when returning to that environment', async () => {
      const prodTokens = makeTokens('prod-user');
      const devTokens = makeTokens('dev-user');

      // Set up prod, then switch to dev (stashes prod token), then log in on dev.
      await store.setAuthTokens(prodTokens);
      await store.switchApiEnvironment('dev');
      await store.setAuthTokens(devTokens);

      // Switch back to prod; should restore prodTokens and stash devTokens.
      const result = await store.switchApiEnvironment('prod');

      expect(result.changed).toBe(true);
      expect(result.url).toBe(getDefaultApiUrl());
      expect(result.authenticated).toBe(true);

      const config = await store.get();
      expect(config.auth).toEqual(prodTokens);
      expect(config.authByEnv?.[LOCAL_DEV_URL]).toEqual(devTokens);
      expect(config.apiConfig).toBeUndefined();
    });

    it('reports authenticated:false when the restored token is expired', async () => {
      const expiredProd = makeTokens('prod-user', PAST);
      await store.setAuthTokens(expiredProd);
      await store.switchApiEnvironment('dev'); // stashes expiredProd

      const result = await store.switchApiEnvironment('prod'); // restores expiredProd

      expect(result.changed).toBe(true);
      expect(result.authenticated).toBe(false);
    });
  });

  describe('logout-then-switch deletes stale cache entry', () => {
    it('removes the previous env entry from authByEnv when there is no active token to stash', async () => {
      const prodTokens = makeTokens('prod-user');
      await store.setAuthTokens(prodTokens);
      await store.switchApiEnvironment('dev'); // stash prodTokens

      // Pretend the user logged out on dev (no current auth) and switches back.
      const config = await store.get();
      expect(config.auth).toBeUndefined(); // dev hasn't authenticated yet

      // Switching from dev to prod with no active auth should DELETE the dev
      // entry (there's nothing to stash), not leave a stale one behind.
      await store.switchApiEnvironment('prod');

      const afterSwitch = await store.get();
      expect(afterSwitch.authByEnv?.[LOCAL_DEV_URL]).toBeUndefined();
      expect(afterSwitch.authByEnv?.[getDefaultApiUrl()]).toEqual(prodTokens); // restored
      expect(afterSwitch.auth).toEqual(prodTokens);
    });
  });

  describe('URL key normalization', () => {
    it('treats trailing-slash and case variants as the same environment', async () => {
      // Manually configure with a trailing-slash custom URL.
      await store.update({ apiConfig: { customUrl: 'https://custom.example.com/' } });
      const tokens = makeTokens('custom-user');
      await store.setAuthTokens(tokens);

      // Switching to a different host stashes under a normalized key.
      await store.switchApiEnvironment('prod');
      const afterStash = await store.get();
      const stashKey = Object.keys(afterStash.authByEnv ?? {})[0];
      expect(stashKey).toBe('https://custom.example.com');

      // Returning via a differently-cased URL hits the same cache entry.
      const result = await store.switchApiEnvironment({ customUrl: 'HTTPS://Custom.Example.com' });

      expect(result.changed).toBe(true);
      expect(result.authenticated).toBe(true);
      const afterReturn = await store.get();
      expect(afterReturn.auth).toEqual(tokens);
    });
  });
});
