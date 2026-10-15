import { describe, expect, it, vi } from 'vitest';
import type { AuthTokens } from '@bike4mind/client-auth';
import { TokenVault, type SecretCipher, type VaultFile } from './tokenVault';

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
});
