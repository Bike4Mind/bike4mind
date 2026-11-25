import { describe, expect, it, vi, afterEach } from 'vitest';
import { openedAs, sealedAs, versionedCipher } from '../secrets/versionedCipher.testHelper';
import { TokenVault, type VaultFile } from './tokenVault';
import type { SecretCipher } from '../../host/ports';
import { migrateSelection, normalizeSelection, resolveEnvironment, validateSelection } from './environment';
import { SessionRevokedError, type AuthTokens, type AuthenticatedApiClient } from '@bike4mind/client-auth';
import { classifyIdentifyFailure } from './identifyFailure';
import { MIN_REFRESH_DELAY_MS, REFRESH_SKEW_MS, msUntilProactiveRefresh, msUntilRefreshRetry } from './refreshSchedule';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaStore } from '../chat/media/MediaStore';
import {
  fetchProfilePhoto,
  ProfilePhotoCache,
  profilePhotoCacheKey,
  resolveProfilePhotoUrl,
  type PhotoRecordFile,
} from './profilePhoto';

describe('tokenVault', () => {
  const TOKENS: AuthTokens = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: '2030-01-01T00:00:00.000Z',
    userId: 'user-1',
  };

  const silentLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

  /** Reversible stand-in for safeStorage; the real one is only usable after the app is ready. */
  function fakeCipher(available = true): SecretCipher {
    return {
      isEncryptionAvailable: () => available,
      encryptString: plain => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: encrypted => {
        const text = encrypted.toString('utf8');
        if (!text.startsWith('enc:')) throw new Error('not encrypted by this cipher');
        return text.slice(4);
      },
    };
  }

  function memoryFile(initial: string | null = null): VaultFile & { contents: string | null } {
    return {
      contents: initial,
      async read() {
        return this.contents;
      },
      async write(contents: string) {
        this.contents = contents;
      },
    };
  }

  describe('TokenVault', () => {
    it('round-trips tokens through the cipher and keeps them off disk in plain text', async () => {
      const file = memoryFile();
      const vault = new TokenVault(fakeCipher(), file, silentLogger);

      await vault.setTokens('https://b4m.example.com', TOKENS);

      expect(file.contents).not.toContain('refresh');
      expect(await vault.getTokens('https://b4m.example.com')).toEqual(TOKENS);
    });

    it('keys tokens per normalized environment so switching back does not re-authenticate', async () => {
      const file = memoryFile();
      const vault = new TokenVault(fakeCipher(), file, silentLogger);

      await vault.setTokens('https://b4m.example.com', TOKENS);
      const other = { ...TOKENS, userId: 'user-2' };
      await vault.setTokens('http://localhost:3000', other);

      // Trailing slash and case differ only in spelling; they must hit the same entry.
      expect(await vault.getTokens('HTTPS://B4M.example.com/')).toEqual(TOKENS);
      expect(await vault.getTokens('http://localhost:3000')).toEqual(other);
    });

    it('clears only the environment it was asked to clear', async () => {
      const file = memoryFile();
      const vault = new TokenVault(fakeCipher(), file, silentLogger);
      await vault.setTokens('https://a.example.com', TOKENS);
      await vault.setTokens('https://b.example.com', TOKENS);

      await vault.clearTokens('https://a.example.com');

      expect(await vault.getTokens('https://a.example.com')).toBeNull();
      expect(await vault.getTokens('https://b.example.com')).toEqual(TOKENS);
    });

    it('degrades to memory-only rather than writing plain text when encryption is unavailable', async () => {
      const file = memoryFile();
      const vault = new TokenVault(fakeCipher(false), file, silentLogger);

      expect(vault.storageStatus()).toBe('unavailable');
      await vault.setTokens('https://b4m.example.com', TOKENS);

      // Usable for this session...
      expect(await vault.getTokens('https://b4m.example.com')).toEqual(TOKENS);
      // ...but nothing was persisted, so the next launch starts signed out.
      expect(file.contents).toBeNull();
    });

    describe('with a cipher that declares file-permission protection instead of encryption', () => {
      const permissionCipher: SecretCipher = {
        atRestProtection: 'file-permissions',
        isEncryptionAvailable: () => false,
        encryptString: plain => Buffer.from(plain, 'utf8'),
        decryptString: encoded => encoded.toString('utf8'),
      };

      it('persists tokens and reports file-permission storage rather than encryption', async () => {
        const file = memoryFile();
        const vault = new TokenVault(permissionCipher, file, silentLogger);

        expect(vault.storageStatus()).toBe('file-permissions');
        await vault.setTokens('https://b4m.example.com', TOKENS);

        const restarted = new TokenVault(permissionCipher, file, silentLogger);
        expect(await restarted.getTokens('https://b4m.example.com')).toEqual(TOKENS);
      });

      it('applies a conditional refresh write against the persisted copy', async () => {
        const file = memoryFile();
        const vault = new TokenVault(permissionCipher, file, silentLogger);
        const store = vault.storeFor('https://b4m.example.com');
        await store.setAuthTokens(TOKENS);

        const rotated = { ...TOKENS, accessToken: 'access-2', refreshToken: 'refresh-2' };
        expect(await store.setAuthTokens(rotated, 'stale-refresh')).toBe(false);
        expect(await store.setAuthTokens(rotated, TOKENS.refreshToken)).toBe(true);

        const restarted = new TokenVault(permissionCipher, file, silentLogger);
        expect(await restarted.getTokens('https://b4m.example.com')).toEqual(rotated);
      });

      it('removes cleared tokens from disk', async () => {
        const file = memoryFile();
        const vault = new TokenVault(permissionCipher, file, silentLogger);
        await vault.setTokens('https://b4m.example.com', TOKENS);

        await vault.clearTokens('https://b4m.example.com');

        expect(JSON.parse(file.contents!).tokens).toEqual({});
      });
    });

    it('treats a cipher that can encrypt as encrypted storage even if it also declares file permissions', () => {
      const vault = new TokenVault(
        { ...fakeCipher(true), atRestProtection: 'file-permissions' },
        memoryFile(),
        silentLogger
      );
      expect(vault.storageStatus()).toBe('available');
    });

    it('discards an unreadable blob instead of wedging the environment', async () => {
      const file = memoryFile(
        JSON.stringify({ version: 1, tokens: { 'https://b4m.example.com': Buffer.from('garbage').toString('base64') } })
      );
      const vault = new TokenVault(fakeCipher(), file, silentLogger);

      expect(await vault.getTokens('https://b4m.example.com')).toBeNull();
      expect(JSON.parse(file.contents!).tokens).toEqual({});
    });

    it('remembers the environment selection in plain text so an undecryptable vault still points somewhere', async () => {
      const file = memoryFile();
      const vault = new TokenVault(fakeCipher(), file, silentLogger);

      await vault.setEnvironment({ preset: 'custom', customUrl: 'https://b4m.example.com' });

      expect(await vault.getEnvironment()).toEqual({ preset: 'custom', customUrl: 'https://b4m.example.com' });
      expect(file.contents).toContain('b4m.example.com');
    });

    it('exposes a TokenStore bound to one environment', async () => {
      const vault = new TokenVault(fakeCipher(), memoryFile(), silentLogger);
      const store = vault.storeFor('https://b4m.example.com');

      expect(await store.isAuthenticated()).toBe(false);
      await store.setAuthTokens(TOKENS);
      expect(await store.isAuthenticated()).toBe(true);
      expect(await store.getAuthTokens()).toEqual(TOKENS);

      await store.clearAuthTokens();
      expect(await store.getAuthTokens()).toBeNull();
    });

    describe('two processes sharing one vault file', () => {
      const HOSTED = 'https://b4m.example.com';
      const ROTATED: AuthTokens = { ...TOKENS, accessToken: 'access-2', refreshToken: 'refresh-2' };

      it('reloadTokens sees a rotation the other process wrote, where getTokens serves its cache', async () => {
        const file = memoryFile();
        const mine = new TokenVault(fakeCipher(), file, silentLogger);
        const theirs = new TokenVault(fakeCipher(), file, silentLogger);
        await mine.setTokens(HOSTED, TOKENS);

        await theirs.setTokens(HOSTED, ROTATED);

        expect(await mine.getTokens(HOSTED)).toEqual(TOKENS);
        expect(await mine.reloadTokens(HOSTED)).toEqual(ROTATED);
        // The reload refreshed the cache, so the request path now carries the new token too.
        expect(await mine.getTokens(HOSTED)).toEqual(ROTATED);
        expect(await mine.storeFor(HOSTED).reloadAuthTokens?.()).toEqual(ROTATED);
      });

      it('reloadTokens reports a sign-out the other process made', async () => {
        const file = memoryFile();
        const mine = new TokenVault(fakeCipher(), file, silentLogger);
        const theirs = new TokenVault(fakeCipher(), file, silentLogger);
        await mine.setTokens(HOSTED, TOKENS);

        await theirs.clearTokens(HOSTED);

        expect(await mine.reloadTokens(HOSTED)).toBeNull();
        expect(await mine.getTokens(HOSTED)).toBeNull();
      });

      it('a write never puts back tokens the other process replaced', async () => {
        const file = memoryFile();
        const mine = new TokenVault(fakeCipher(), file, silentLogger);
        const theirs = new TokenVault(fakeCipher(), file, silentLogger);
        await mine.setTokens(HOSTED, TOKENS);
        await mine.getEnvironment();

        await theirs.setTokens(HOSTED, ROTATED);
        // Unrelated writes from the instance holding the stale copy.
        await mine.setEnvironment({ preset: 'custom', customUrl: 'https://other.example.com' });
        await mine.setTokens('https://other.example.com', TOKENS);

        expect(await new TokenVault(fakeCipher(), file, silentLogger).getTokens(HOSTED)).toEqual(ROTATED);
      });
    });

    it('keeps its cached tokens when a reload fails to decrypt, but a cold read still clears', async () => {
      const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      let failDecrypt = false;
      const cipher = fakeCipher();
      const flaky: SecretCipher = {
        ...cipher,
        decryptString: encrypted => {
          if (failDecrypt) throw new Error('keychain hiccup');
          return cipher.decryptString(encrypted);
        },
      };
      const file = memoryFile();
      const vault = new TokenVault(flaky, file, logger);
      await vault.setTokens('https://b4m.example.com', TOKENS);

      failDecrypt = true;

      expect(await vault.reloadTokens('https://b4m.example.com')).toEqual(TOKENS);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('keeping the copy in memory'));
      expect(JSON.parse(file.contents ?? '{}').tokens['https://b4m.example.com']).toBeTruthy();

      const cold = new TokenVault(flaky, file, logger);
      expect(await cold.getTokens('https://b4m.example.com')).toBeNull();
    });

    it('logs why it clears a blob it cannot decrypt', async () => {
      const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const file = memoryFile(
        JSON.stringify({ version: 1, tokens: { 'https://b4m.example.com': Buffer.from('garbage').toString('base64') } })
      );
      const vault = new TokenVault(fakeCipher(), file, logger);

      expect(await vault.getTokens('https://b4m.example.com')).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/clearing stored credentials .* vault decrypt failed/)
      );
    });
  });

  describe('TokenVault.reencrypt', () => {
    const A = 'https://a.example.com';
    const B = 'https://b.example.com';
    const OTHER: AuthTokens = { ...TOKENS, userId: 'user-2' };

    function storedVault(blobs: Record<string, string>) {
      const file = memoryFile(JSON.stringify({ version: 1, environment: { preset: 'hosted' }, tokens: blobs }));
      const write = vi.spyOn(file, 'write');
      return { file, write, tokens: () => JSON.parse(file.contents ?? '{}').tokens as Record<string, string> };
    }

    it('re-seals each legacy blob once and leaves current ones as they are', async () => {
      const stored = storedVault({
        [A]: sealedAs('old', JSON.stringify(TOKENS)),
        [B]: sealedAs('new', JSON.stringify(OTHER)),
      });
      const vault = new TokenVault(versionedCipher('new'), stored.file, silentLogger);

      await vault.reencrypt();

      expect(openedAs(stored.tokens()[A])).toBe(`new:${JSON.stringify(TOKENS)}`);
      expect(stored.tokens()[B]).toBe(sealedAs('new', JSON.stringify(OTHER)));
      expect(JSON.parse(stored.file.contents ?? '{}').environment).toEqual({ preset: 'hosted' });
      expect(stored.write).toHaveBeenCalledTimes(1);

      await vault.reencrypt();
      expect(stored.write).toHaveBeenCalledTimes(1);
      expect(await vault.getTokens(A)).toEqual(TOKENS);
      expect(await vault.getTokens(B)).toEqual(OTHER);
    });

    it('keeps a legacy blob it cannot open, and the read path then treats it as before', async () => {
      const blob = sealedAs('old', JSON.stringify(TOKENS));
      const stored = storedVault({ [A]: blob });
      const vault = new TokenVault(versionedCipher('new', { opensOld: false }), stored.file, silentLogger);

      await vault.reencrypt();

      expect(stored.write).not.toHaveBeenCalled();
      expect(stored.tokens()[A]).toBe(blob);
    });

    it('leaves the file alone when encryption is unavailable or the cipher asks for no migration', async () => {
      const blob = sealedAs('old', JSON.stringify(TOKENS));
      for (const cipher of [versionedCipher('new', { available: false }), fakeCipher()]) {
        const stored = storedVault({ [A]: blob });
        const read = vi.spyOn(stored.file, 'read');

        await new TokenVault(cipher, stored.file, silentLogger).reencrypt();

        expect(read).not.toHaveBeenCalled();
        expect(stored.write).not.toHaveBeenCalled();
      }
    });
  });

  describe('TokenVault conditional refresh writes', () => {
    it('keeps the current account when an earlier refresh attempts to save', async () => {
      const vault = new TokenVault(fakeCipher(), memoryFile(), silentLogger);
      const current = { ...TOKENS, userId: 'other-user', refreshToken: 'other-refresh' };
      await vault.setTokens('https://api.example.test', current);
      expect(await vault.storeFor('https://api.example.test').setAuthTokens(TOKENS, 'earlier-refresh')).toBe(false);
      expect(await vault.getTokens('https://api.example.test')).toEqual(current);
    });

    it('keeps current credentials when an earlier refresh attempts to clear', async () => {
      const vault = new TokenVault(fakeCipher(), memoryFile(), silentLogger);
      await vault.setTokens('https://api.example.test', TOKENS);
      expect(await vault.storeFor('https://api.example.test').clearAuthTokens('earlier-refresh')).toBe(false);
      expect(await vault.getTokens('https://api.example.test')).toEqual(TOKENS);
    });

    it('orders document mutations through persistence', async () => {
      const firstWrite = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const file = memoryFile();
      const write = file.write.bind(file);
      const writes = vi.spyOn(file, 'write').mockImplementationOnce(async contents => {
        entered.resolve();
        await firstWrite.promise;
        await write(contents);
      });
      const vault = new TokenVault(fakeCipher(), file, silentLogger);
      const first = vault.setTokens('https://a.example.test', TOKENS);
      let second: Promise<void> | undefined;
      try {
        await entered.promise;
        second = vault.setTokens('https://b.example.test', { ...TOKENS, userId: 'other-user' });
        for (let turn = 0; turn < 12; turn++) await Promise.resolve();
        expect(writes).toHaveBeenCalledTimes(1);
        firstWrite.resolve();
        await Promise.all([first, second]);
        const reopened = new TokenVault(fakeCipher(), file, silentLogger);
        expect(await reopened.getTokens('https://a.example.test')).toEqual(TOKENS);
        expect((await reopened.getTokens('https://b.example.test'))?.userId).toBe('other-user');
      } finally {
        firstWrite.resolve();
        await Promise.all([first, second]);
      }
    });
  });

  describe('TokenVault conditional writes with an unreadable current blob', () => {
    it.each(['set', 'clear'] as const)(
      'preserves a newer disk blob when %s cannot verify its owner',
      async operation => {
        const file = memoryFile();
        const crypto = fakeCipher();
        const vault = new TokenVault(crypto, file, silentLogger);
        await vault.setTokens('https://a.example.test', TOKENS);
        const external = new TokenVault(fakeCipher(), file, silentLogger);
        await external.setTokens('https://a.example.test', {
          ...TOKENS,
          refreshToken: 'newer-refresh',
          userId: 'newer-user',
        });
        const persisted = file.contents;
        vi.spyOn(crypto, 'decryptString').mockImplementation(() => {
          throw new Error('Temporarily unavailable');
        });
        const store = vault.storeFor('https://a.example.test');
        const result =
          operation === 'set'
            ? await store.setAuthTokens({ ...TOKENS, refreshToken: 'stale-rotation' }, TOKENS.refreshToken)
            : await store.clearAuthTokens(TOKENS.refreshToken);
        expect(result).toBe(false);
        expect(file.contents).toBe(persisted);
        expect((await external.reloadTokens('https://a.example.test'))?.refreshToken).toBe('newer-refresh');
      }
    );
  });

  describe('TokenVault conditional writes with an unreadable disk snapshot', () => {
    it.each(['set', 'clear'] as const)('preserves a newer snapshot when %s cannot reread it', async operation => {
      const file = memoryFile();
      const vault = new TokenVault(fakeCipher(), file, silentLogger);
      await vault.setTokens('https://a.example.test', TOKENS);
      const external = new TokenVault(fakeCipher(), file, silentLogger);
      await external.setTokens('https://a.example.test', { ...TOKENS, refreshToken: 'newer-refresh' });
      const persisted = file.contents;
      vi.spyOn(file, 'read').mockRejectedValueOnce(new Error('Disk temporarily unavailable'));
      const write = vi.spyOn(file, 'write');
      const store = vault.storeFor('https://a.example.test');
      const result =
        operation === 'set'
          ? await store.setAuthTokens({ ...TOKENS, refreshToken: 'stale-rotation' }, TOKENS.refreshToken)
          : await store.clearAuthTokens(TOKENS.refreshToken);
      expect(result).toBe(false);
      expect(write).not.toHaveBeenCalled();
      expect(file.contents).toBe(persisted);
    });
  });

  describe('TokenVault memory-only conditional writes', () => {
    it('rotates and clears the matching cached session without needing disk access', async () => {
      const file = memoryFile();
      const vault = new TokenVault(fakeCipher(false), file, silentLogger);
      await vault.setTokens('https://a.example.test', TOKENS);
      const read = vi.spyOn(file, 'read').mockRejectedValue(new Error('Disk unavailable'));
      const write = vi.spyOn(file, 'write');
      const store = vault.storeFor('https://a.example.test');
      const next = { ...TOKENS, refreshToken: 'rotated' };
      expect(await store.setAuthTokens(next, TOKENS.refreshToken)).toBe(true);
      expect(await store.reloadAuthTokens?.()).toEqual(next);
      expect(await store.clearAuthTokens(TOKENS.refreshToken)).toBe(false);
      expect(await store.clearAuthTokens(next.refreshToken)).toBe(true);
      expect(await store.getAuthTokens()).toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    });
  });
});

describe('environment', () => {
  const BAKED = 'B4M_DEFAULT_API_URL';
  const HOSTED = 'https://hosted.example.com';

  afterEach(() => {
    delete process.env[BAKED];
  });

  describe('resolveEnvironment', () => {
    it('uses the baked default for the hosted preset', () => {
      process.env[BAKED] = 'https://b4m.example.com';

      const resolved = resolveEnvironment({ preset: 'hosted' }, false);

      expect(resolved).toEqual({
        status: 'configured',
        environment: { preset: 'hosted', url: 'https://b4m.example.com', label: 'Production' },
      });
    });

    it('honors an explicit local pick over the baked default', () => {
      process.env[BAKED] = 'https://b4m.example.com';

      const resolved = resolveEnvironment({ preset: 'local' }, false);

      expect(resolved).toEqual({
        status: 'configured',
        environment: { preset: 'local', url: 'http://localhost:3000', label: 'Local Dev' },
      });
    });

    it('labels a remote custom URL distinctly from a local one', () => {
      const remote = resolveEnvironment({ preset: 'custom', customUrl: 'https://b4m.internal' }, false);
      const localCustom = resolveEnvironment({ preset: 'custom', customUrl: 'http://127.0.0.1:3000' }, false);

      expect(remote).toMatchObject({ environment: { label: 'Remote' } });
      expect(localCustom).toMatchObject({ environment: { label: 'Local Dev' } });
    });

    it('is unconfigured for an unbranded packaged build with no choice made', () => {
      expect(resolveEnvironment(undefined, false)).toEqual({ status: 'unconfigured' });
    });

    it('starts a packaged build with a baked default on Production when nothing is stored', () => {
      process.env[BAKED] = HOSTED;

      expect(resolveEnvironment(undefined, false)).toEqual({
        status: 'configured',
        environment: { preset: 'hosted', url: HOSTED, label: 'Production' },
      });
    });

    it('treats an empty baked default as a fork with no hosted option', () => {
      process.env[BAKED] = '';

      expect(resolveEnvironment(undefined, false)).toEqual({ status: 'unconfigured' });
    });

    it('resolves a custom pick of the production URL as Production', () => {
      process.env[BAKED] = HOSTED;

      expect(resolveEnvironment({ preset: 'custom', customUrl: `${HOSTED.toUpperCase()}/` }, false)).toEqual({
        status: 'configured',
        environment: { preset: 'hosted', url: HOSTED, label: 'Production' },
      });
    });

    it('keeps a custom URL that is not the production one', () => {
      process.env[BAKED] = HOSTED;

      expect(resolveEnvironment({ preset: 'custom', customUrl: 'https://self-hosted.example.com' }, false)).toEqual({
        status: 'configured',
        environment: { preset: 'custom', url: 'https://self-hosted.example.com', label: 'Remote' },
      });
    });

    it('falls back to the dev server for a source run', () => {
      expect(resolveEnvironment(undefined, true)).toMatchObject({
        status: 'configured',
        environment: { preset: 'local', url: 'http://localhost:3000' },
      });
    });

    it('does not silently substitute the hosted service for a custom pick that lost its URL', () => {
      process.env[BAKED] = 'https://b4m.example.com';

      expect(resolveEnvironment({ preset: 'custom' }, true)).toEqual({ status: 'unconfigured' });
    });
  });

  describe('migrateSelection', () => {
    it.each([
      ['https://hosted.example.com/Api', 'https://hosted.example.com/api'],
      ['https://hosted.example.com?tenant=Acme', 'https://hosted.example.com?tenant=acme'],
      ['https://User:Secret@hosted.example.com', 'https://user:secret@hosted.example.com'],
      ['https://hosted.example.com?tenant=acme/', 'https://hosted.example.com?tenant=acme'],
    ])('preserves a distinct custom endpoint %s', (baked, customUrl) => {
      process.env[BAKED] = baked;
      const selection = { preset: 'custom' as const, customUrl };

      expect(migrateSelection(selection)).toBe(selection);
      expect(normalizeSelection(selection)).toEqual(selection);
      expect(resolveEnvironment(selection, false)).toMatchObject({
        environment: { preset: 'custom', url: customUrl },
      });
    });

    it('turns a custom pick of the production URL into the hosted preset', () => {
      process.env[BAKED] = HOSTED;

      expect(migrateSelection({ preset: 'custom', customUrl: HOSTED })).toEqual({ preset: 'hosted' });
    });

    it('returns every other selection unchanged, by reference', () => {
      process.env[BAKED] = HOSTED;
      const other = { preset: 'custom' as const, customUrl: 'https://self-hosted.example.com' };

      expect(migrateSelection(other)).toBe(other);
      expect(migrateSelection(undefined)).toBeUndefined();
    });

    it('migrates nothing in a fork, where there is no production URL to match', () => {
      const custom = { preset: 'custom' as const, customUrl: HOSTED };

      expect(migrateSelection(custom)).toBe(custom);
    });
  });

  describe('validateSelection', () => {
    it('rejects a custom URL that is not an http(s) origin', () => {
      expect(validateSelection({ preset: 'custom', customUrl: 'ftp://b4m.example.com' }).ok).toBe(false);
      expect(validateSelection({ preset: 'custom', customUrl: '' }).ok).toBe(false);
      expect(validateSelection({ preset: 'custom', customUrl: 'https://b4m.example.com' }).ok).toBe(true);
    });

    it('does not require a URL for the presets that supply their own', () => {
      expect(validateSelection({ preset: 'hosted' }).ok).toBe(true);
      expect(validateSelection({ preset: 'local' }).ok).toBe(true);
    });
  });

  describe('normalizeSelection', () => {
    it('trims and strips a trailing slash so the stored URL matches the token cache key', () => {
      expect(normalizeSelection({ preset: 'custom', customUrl: '  https://b4m.example.com/  ' })).toEqual({
        preset: 'custom',
        customUrl: 'https://b4m.example.com',
      });
    });

    it('stores a typed-in production URL as the hosted preset', () => {
      process.env[BAKED] = HOSTED;

      expect(normalizeSelection({ preset: 'custom', customUrl: ` ${HOSTED}/ ` })).toEqual({ preset: 'hosted' });
    });

    it('drops a stale custom URL when the preset is not custom', () => {
      expect(normalizeSelection({ preset: 'local', customUrl: 'https://b4m.example.com' })).toEqual({
        preset: 'local',
      });
    });
  });
});

describe('identifyFailure', () => {
  function httpError(status: number, data: unknown, message = 'Request failed') {
    return Object.assign(new Error(message), { response: { status, data } });
  }

  describe('classifyIdentifyFailure', () => {
    it('reads a 403 policy gate as its own state, not a sign-in failure', () => {
      const failure = classifyIdentifyFailure(
        httpError(403, {
          error: 'Policy acceptance required.',
          error_description: 'Accept the Terms of Service and Acceptable Use Policy to continue.',
          policyAcceptanceRequired: true,
        })
      );

      expect(failure.outcome).toBe('policy-acceptance-required');
      expect(failure.error.remedy).toBe('accept-policy');
      expect(failure.error.message).toContain('Acceptable Use Policy');
    });

    it('reads a 401 mfaPending as its own state, not a sign-in failure', () => {
      const failure = classifyIdentifyFailure(
        httpError(401, { error: 'MFA setup or verification required.', mfaPending: true })
      );

      expect(failure.outcome).toBe('mfa-required');
      expect(failure.error.remedy).toBe('complete-mfa');
      expect(failure.error.message).toBe('MFA setup or verification required.');
    });

    it('treats a plain 401 as a revoked session', () => {
      const failure = classifyIdentifyFailure(httpError(401, { error: 'Unauthorized' }));

      expect(failure.outcome).toBe('signed-out');
      expect(failure.error.remedy).toBe('retry-sign-in');
    });

    it('treats SessionRevokedError as a revoked session and keeps its message', () => {
      const failure = classifyIdentifyFailure(new SessionRevokedError('Your session expired. Sign in again.'));

      expect(failure.outcome).toBe('signed-out');
      expect(failure.error.message).toBe('Your session expired. Sign in again.');
    });

    it('keeps the session for a 5xx or a network failure', () => {
      expect(classifyIdentifyFailure(httpError(503, { error: 'nope' })).outcome).toBe('transient');
      expect(classifyIdentifyFailure(new Error('getaddrinfo ENOTFOUND')).outcome).toBe('transient');
      expect(classifyIdentifyFailure(undefined).outcome).toBe('transient');
    });

    it('does not mistake a 403 without the policy flag for the policy gate', () => {
      expect(classifyIdentifyFailure(httpError(403, { error: 'Forbidden' })).outcome).toBe('transient');
    });
  });
});

describe('refreshSchedule', () => {
  const ACCESS_TOKEN_TTL_MS = 30 * 60 * 1000;

  describe('msUntilProactiveRefresh', () => {
    it('fires ahead of expiry, not at it', () => {
      const now = Date.UTC(2026, 0, 1);
      const expiresAt = new Date(now + ACCESS_TOKEN_TTL_MS).toISOString();

      const delay = msUntilProactiveRefresh(expiresAt, now);

      expect(delay).toBe(ACCESS_TOKEN_TTL_MS - REFRESH_SKEW_MS);
      expect(delay).toBeLessThan(ACCESS_TOKEN_TTL_MS);
    });

    it('collapses to the floor for an expiry already inside the skew window', () => {
      const now = Date.UTC(2026, 0, 1);
      const expiresAt = new Date(now + 60_000).toISOString();

      expect(msUntilProactiveRefresh(expiresAt, now)).toBe(MIN_REFRESH_DELAY_MS);
    });

    it('never returns a negative delay for an already-expired token', () => {
      const now = Date.UTC(2026, 0, 1);

      expect(msUntilProactiveRefresh(new Date(now - ACCESS_TOKEN_TTL_MS).toISOString(), now)).toBe(
        MIN_REFRESH_DELAY_MS
      );
    });

    it('treats an unparseable expiry as due now rather than never', () => {
      expect(msUntilProactiveRefresh('not-a-date', Date.now())).toBe(MIN_REFRESH_DELAY_MS);
    });
  });

  describe('msUntilRefreshRetry', () => {
    it('backs off and then holds at a ceiling', () => {
      expect(msUntilRefreshRetry(1)).toBe(30_000);
      expect(msUntilRefreshRetry(2)).toBe(60_000);
      expect(msUntilRefreshRetry(3)).toBe(120_000);
      expect(msUntilRefreshRetry(10)).toBe(5 * 60 * 1000);
    });
  });
});

describe('profilePhoto', () => {
  const KEY = 'profile-photos/user-1/aaaa.png';
  const silentLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

  function memoryRecord(): PhotoRecordFile {
    let contents: string | null = null;
    return {
      async read() {
        return contents;
      },
      async write(next: string) {
        contents = next;
      },
      async remove() {
        contents = null;
      },
    };
  }

  async function cache(): Promise<ProfilePhotoCache> {
    const base = await mkdtemp(join(tmpdir(), 'b4m-profile-photo-'));
    return new ProfilePhotoCache(new MediaStore(base), memoryRecord());
  }

  /** A one-pixel PNG is enough: MediaStore only cares that the bytes are non-empty. */
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

  function apiReturning(body: unknown, contentType: string): AuthenticatedApiClient {
    return {
      getAxiosInstance: () => ({
        get: vi.fn().mockResolvedValue({ data: body, headers: { 'content-type': contentType } }),
      }),
    } as unknown as AuthenticatedApiClient;
  }

  describe('profilePhotoCacheKey', () => {
    it('changes when the upload does, because the key carries the upload uuid', () => {
      expect(profilePhotoCacheKey('user-1', 'profile-photos/user-1/aaaa.png')).not.toBe(
        profilePhotoCacheKey('user-1', 'profile-photos/user-1/bbbb.png')
      );
    });

    it('separates two accounts that share a photo source', () => {
      expect(profilePhotoCacheKey('user-1', 'https://cdn.example.com/legacy.png')).not.toBe(
        profilePhotoCacheKey('user-2', 'https://cdn.example.com/legacy.png')
      );
    });

    it('is stable for the same account and upload', () => {
      expect(profilePhotoCacheKey('user-1', KEY)).toBe(profilePhotoCacheKey('user-1', KEY));
    });
  });

  describe('resolveProfilePhotoUrl', () => {
    it('joins a bucket key onto an absolute CDN base', () => {
      expect(resolveProfilePhotoUrl(KEY, 'https://cdn.example.com/')).toBe(`https://cdn.example.com/${KEY}`);
    });

    it('joins a bucket key onto the self-host proxy path', () => {
      expect(resolveProfilePhotoUrl(KEY, '/api/app-files/serve')).toBe(`/api/app-files/serve/${KEY}`);
    });

    it('passes an already-absolute source through untouched', () => {
      expect(resolveProfilePhotoUrl('https://example.com/me.jpg', '')).toBe('https://example.com/me.jpg');
    });

    it('gives up on a key when the deployment advertises no CDN base', () => {
      expect(resolveProfilePhotoUrl(KEY, '')).toBeNull();
    });
  });

  describe('ProfilePhotoCache', () => {
    it('can store a new account photo after clearing the same cache instance', async () => {
      const store = await cache();
      await store.store('account-a', PNG, 'image/png');
      await store.clear();
      const url = await store.store('account-b', PNG, 'image/png');
      expect(await store.lookup('account-a')).toBeNull();
      expect(await store.lookup('account-b')).toBe(url);
    });

    it.each(['media', 'sidecar'])('waits for an active %s write before completing sign-out cleanup', async stage => {
      const base = await mkdtemp(join(tmpdir(), 'b4m-profile-photo-race-'));
      const media = new MediaStore(base);
      const record = memoryRecord();
      const store = new ProfilePhotoCache(media, record);
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>(resolve => {
        enter = resolve;
      });
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      if (stage === 'media') {
        const save = media.save.bind(media);
        vi.spyOn(media, 'save').mockImplementation(async (...args) => {
          enter();
          await gate;
          return save(...args);
        });
      } else {
        const write = record.write.bind(record);
        vi.spyOn(record, 'write').mockImplementation(async contents => {
          enter();
          await gate;
          await write(contents);
        });
      }
      const outcome = store.store('account-a', PNG, 'image/png').catch((error: unknown) => error);
      await entered;
      let cleared = false;
      const clearing = store.clear().then(() => {
        cleared = true;
      });
      await Promise.resolve();
      expect(cleared).toBe(false);
      release();
      expect(await outcome).toBeInstanceOf(Error);
      await clearing;
      expect(await record.read()).toBeNull();
      expect(await readdir(base)).toEqual([]);
    });

    it('invalidates queued pre-sign-out stores and accepts a later account', async () => {
      const store = await cache();
      const first = store.store('old-a', PNG, 'image/png').catch((error: unknown) => error);
      const second = store.store('old-b', PNG, 'image/png').catch((error: unknown) => error);
      const clearing = store.clear();
      const next = store.store('new-account', PNG, 'image/png');
      expect(await first).toBeInstanceOf(Error);
      expect(await second).toBeInstanceOf(Error);
      await clearing;
      expect(await store.lookup('new-account')).toBe(await next);
      expect(await store.lookup('old-a')).toBeNull();
    });

    it('does not poison cleanup or the next store when a write fails', async () => {
      const media = new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-profile-photo-failure-')));
      const record = memoryRecord();
      const store = new ProfilePhotoCache(media, record);
      vi.spyOn(record, 'write').mockRejectedValueOnce(new Error('disk unavailable'));
      await expect(store.store('old', PNG, 'image/png')).rejects.toThrow('disk unavailable');
      await store.clear();
      const url = await store.store('new', PNG, 'image/png');
      expect(await store.lookup('new')).toBe(url);
    });

    it('returns the stored url for the key it was stored under', async () => {
      const store = await cache();
      const url = await store.store(profilePhotoCacheKey('user-1', KEY), PNG, 'image/png');

      expect(url).toMatch(/^b4m-media:\/\/media\/profile-photo\//);
      await expect(store.lookup(profilePhotoCacheKey('user-1', KEY))).resolves.toBe(url);
    });

    it('misses when the photo has been replaced', async () => {
      const store = await cache();
      await store.store(profilePhotoCacheKey('user-1', KEY), PNG, 'image/png');

      await expect(store.lookup(profilePhotoCacheKey('user-1', 'profile-photos/user-1/bbbb.png'))).resolves.toBeNull();
    });

    it('keeps only the newest photo on disk', async () => {
      const store = await cache();
      const first = await store.store(profilePhotoCacheKey('user-1', KEY), PNG, 'image/png');
      const second = await store.store(
        profilePhotoCacheKey('user-1', 'profile-photos/user-1/bbbb.png'),
        PNG,
        'image/png'
      );

      expect(second).not.toBe(first);
      await expect(store.lookup(profilePhotoCacheKey('user-1', KEY))).resolves.toBeNull();
    });

    it('leaves nothing behind after a sign-out', async () => {
      const store = await cache();
      await store.store(profilePhotoCacheKey('user-1', KEY), PNG, 'image/png');
      await store.clear();

      await expect(store.lookup(profilePhotoCacheKey('user-1', KEY))).resolves.toBeNull();
    });
  });

  describe('fetchProfilePhoto', () => {
    const request = async (api: AuthenticatedApiClient, cdnUrl = '/api/app-files/serve') => ({
      api,
      cache: await cache(),
      logger: silentLogger,
      userId: 'user-1',
      source: KEY,
      cdnUrl,
    });

    it('stores an image response and hands back a local url', async () => {
      const url = await fetchProfilePhoto(await request(apiReturning(PNG, 'image/png')));
      expect(url).toMatch(/^b4m-media:\/\/media\/profile-photo\//);
    });

    it('refuses a login page rather than writing it to disk as a picture', async () => {
      const html = Buffer.from('<html>sign in</html>', 'utf8');
      await expect(fetchProfilePhoto(await request(apiReturning(html, 'text/html')))).resolves.toBeNull();
    });

    it('refuses a response whose type is not one the media protocol can serve', async () => {
      await expect(fetchProfilePhoto(await request(apiReturning(PNG, 'image/tiff')))).resolves.toBeNull();
    });

    it('gives up quietly when the download fails', async () => {
      const api = {
        getAxiosInstance: () => ({ get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }),
      } as unknown as AuthenticatedApiClient;

      await expect(fetchProfilePhoto(await request(api))).resolves.toBeNull();
    });

    it('rechecks the auth generation inside the queued cache store', async () => {
      const requestValue = await request(apiReturning(PNG, 'image/png'));
      const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
      expect(await fetchProfilePhoto({ ...requestValue, isCurrent })).toBeNull();
      expect(isCurrent).toHaveBeenCalledTimes(2);
      expect(await requestValue.cache.lookup(profilePhotoCacheKey('user-1', KEY))).toBeNull();
    });

    it('writes nothing once the session it belongs to has ended', async () => {
      const request = {
        api: apiReturning(PNG, 'image/png'),
        cache: await cache(),
        logger: silentLogger,
        userId: 'user-1',
        source: KEY,
        cdnUrl: '/api/app-files/serve',
        isCurrent: () => false,
      };

      await expect(fetchProfilePhoto(request)).resolves.toBeNull();
      await expect(request.cache.lookup(profilePhotoCacheKey('user-1', KEY))).resolves.toBeNull();
    });

    it('does not download at all when the key cannot be placed', async () => {
      const get = vi.fn();
      const api = { getAxiosInstance: () => ({ get }) } as unknown as AuthenticatedApiClient;

      await expect(fetchProfilePhoto(await request(api, ''))).resolves.toBeNull();
      expect(get).not.toHaveBeenCalled();
    });
  });
});
