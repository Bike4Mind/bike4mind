import { z } from 'zod';
import { normalizeEnvKey, type AuthLogger, type AuthTokens, type TokenStore } from '@bike4mind/client-auth';
import type { EnvironmentSelection, TokenStorageStatus } from '@shared/auth';
import type { SecretCipher } from '../../host/ports';
import { resealed } from '../secrets/reseal';

/** Persistence port for the vault document. Backed by a JSON file under `userData`. */
export interface VaultFile {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
}

/**
 * On-disk shape. Token blobs are per environment and individually encrypted; `environment`
 * is the user's endpoint choice, which is not a secret and stays plaintext so a vault that
 * cannot decrypt still remembers which backend to point at.
 */
interface VaultDocument {
  version: 1;
  environment?: EnvironmentSelection;
  /** normalized API URL -> base64 safeStorage ciphertext of an {@link AuthTokens} JSON. */
  tokens: Record<string, string>;
}

const EMPTY_DOCUMENT: VaultDocument = { version: 1, tokens: {} };

const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
  userId: z.string(),
});

/**
 * Per-environment token storage backed by the OS keychain via `safeStorage`.
 *
 * Deliberately NOT the CLI's `~/.bike4mind/config.json`: that file is plaintext and shared with
 * a different client's session, and a desktop app has a real keychain available.
 *
 * Two facts drive the design:
 * - `safeStorage` is only usable after the app `ready` event, so nothing here touches the cipher
 *   until a method is called; construct the vault after `whenReady()`.
 * - `isEncryptionAvailable()` is false on Linux with no keyring. In that case the vault degrades
 *   to memory-only for tokens and reports {@link TokenStorageStatus} `unavailable` so the UI can
 *   say the session will not survive a restart. It never falls back to writing plaintext
 *   unless the cipher explicitly declares file-permission protection, as a headless host's does.
 */
export class TokenVault {
  private document: VaultDocument | null = null;
  /** Decrypted tokens by environment key; the only copy when storage is memory-only. */
  private readonly cache = new Map<string, AuthTokens>();
  private documentOperation: Promise<void> = Promise.resolve();

  /** Keep each local read/compare/write together, including its disk persistence. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.documentOperation.then(operation);
    // A caller receives its failure; the next independent operation can still run.
    this.documentOperation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  constructor(
    private readonly cipher: SecretCipher,
    private readonly file: VaultFile,
    private readonly logger: AuthLogger
  ) {}

  /** Cheap enough to re-ask each time, and the answer can change between launches. */
  storageStatus(): TokenStorageStatus {
    if (this.cipher.isEncryptionAvailable()) return 'available';
    return this.cipher.atRestProtection === 'file-permissions' ? 'file-permissions' : 'unavailable';
  }

  getEnvironment(): Promise<EnvironmentSelection | undefined> {
    return this.serialize(async () => (await this.load()).environment);
  }

  setEnvironment(environment: EnvironmentSelection): Promise<void> {
    return this.serialize(async () => {
      const document = await this.load({ fromDisk: true });
      document.environment = environment;
      await this.persist(document);
    });
  }

  getTokens(envUrl: string): Promise<AuthTokens | null> {
    return this.serialize(async () => {
      const cached = this.cache.get(normalizeEnvKey(envUrl));
      if (cached) return cached;
      if (this.storageStatus() === 'unavailable') return null;
      return this.decryptInto(envUrl, await this.load());
    });
  }

  /** Read another process's persisted rotation before presenting credentials. */
  reloadTokens(envUrl: string): Promise<AuthTokens | null> {
    return this.serialize(async () => {
      if (this.storageStatus() === 'unavailable') return this.cache.get(normalizeEnvKey(envUrl)) ?? null;
      return this.decryptInto(envUrl, await this.load({ fromDisk: true }), { keepCachedOnFailure: true });
    });
  }

  async setTokens(envUrl: string, tokens: AuthTokens): Promise<void> {
    await this.writeTokens(envUrl, tokens);
  }

  async clearTokens(envUrl: string): Promise<void> {
    await this.writeTokens(envUrl, null);
  }

  private writeTokens(envUrl: string, tokens: AuthTokens | null, expectedRefreshToken?: string): Promise<boolean> {
    return this.serialize(async () => {
      const key = normalizeEnvKey(envUrl);
      const persisted = this.storageStatus() !== 'unavailable';
      if (!persisted && expectedRefreshToken !== undefined) {
        if (this.cache.get(key)?.refreshToken !== expectedRefreshToken) return false;
        if (tokens) this.cache.set(key, tokens);
        else this.cache.delete(key);
        return true;
      }
      let document: VaultDocument;
      try {
        document = await this.load({ fromDisk: true, requireFresh: expectedRefreshToken !== undefined });
      } catch (error) {
        if (expectedRefreshToken !== undefined) return false;
        throw error;
      }
      if (expectedRefreshToken !== undefined) {
        const current = persisted
          ? await this.decryptInto(envUrl, document, { preserveOnFailure: true })
          : this.cache.get(key);
        if (current?.refreshToken !== expectedRefreshToken) return false;
      }
      if (tokens) {
        this.cache.set(key, tokens);
        if (!persisted) return true;
        document.tokens[key] = this.cipher.encryptString(JSON.stringify(tokens)).toString('base64');
      } else {
        this.cache.delete(key);
        if (!(key in document.tokens)) return true;
        delete document.tokens[key];
      }
      await this.persist(document);
      return true;
    });
  }

  /**
   * Re-saves every blob the cipher reports as an older format. One it cannot open is left on disk
   * for the read path, and tried again on the next launch.
   */
  reencrypt(): Promise<void> {
    return this.serialize(() => this.reencryptDocument());
  }

  private async reencryptDocument(): Promise<void> {
    if (!this.cipher.needsReencrypt || this.storageStatus() === 'unavailable') return;
    const document = await this.load({ fromDisk: true });
    let changed = false;
    for (const [key, blob] of Object.entries(document.tokens)) {
      const next = resealed(this.cipher, blob);
      if (next === null) continue;
      document.tokens[key] = next;
      changed = true;
    }
    if (changed) await this.persist(document);
  }

  /** A {@link TokenStore} bound to one environment, for the shared auth package to consume. */
  storeFor(envUrl: string): TokenStore {
    return {
      getAuthTokens: () => this.getTokens(envUrl),
      reloadAuthTokens: () => this.reloadTokens(envUrl),
      setAuthTokens: (tokens, expected) => this.writeTokens(envUrl, tokens, expected),
      clearAuthTokens: expected => this.writeTokens(envUrl, null, expected),
      isAuthenticated: async () => (await this.getTokens(envUrl)) !== null,
    };
  }

  /**
   * Decrypt one environment's blob out of `document` and make it the cached copy. With
   * `keepCachedOnFailure`, a decrypt failure keeps the copy already in memory instead of clearing.
   */
  private async decryptInto(
    envUrl: string,
    document: VaultDocument,
    {
      keepCachedOnFailure = false,
      preserveOnFailure = false,
    }: {
      keepCachedOnFailure?: boolean;
      preserveOnFailure?: boolean;
    } = {}
  ): Promise<AuthTokens | null> {
    const key = normalizeEnvKey(envUrl);
    const blob = document.tokens[key];
    if (!blob) {
      this.cache.delete(key);
      return null;
    }

    try {
      const parsed = authTokensSchema.parse(JSON.parse(this.cipher.decryptString(Buffer.from(blob, 'base64'))));
      this.cache.set(key, parsed);
      return parsed;
    } catch (err) {
      if (preserveOnFailure) {
        this.logger.warn('AUTH: vault comparison unavailable; preserving stored credentials');
        return null;
      }
      const cached = this.cache.get(key);
      if (keepCachedOnFailure && cached) {
        this.logger.warn(
          `AUTH: vault decrypt failed on reload for ${key}, keeping the copy in memory (${err instanceof Error ? err.name : 'unknown'})`
        );
        return cached;
      }
      // A blob written under a different OS user, a rotated keychain entry, or a truncated
      // write. Drop it rather than wedging the app in a state it can never leave.
      this.logger.warn(
        `AUTH: clearing stored credentials for ${key}: vault decrypt failed (${err instanceof Error ? err.name : 'unknown'})`
      );
      this.cache.delete(key);
      delete document.tokens[key];
      await this.persist(document);
      return null;
    }
  }

  /**
   * The vault document. Reads are served from memory; anything that writes, or must see another
   * process's latest tokens, passes `fromDisk` so it starts from the file as it is now - a
   * read-modify-write over a stale copy would put back tokens that process already replaced.
   */
  private async load({
    fromDisk = false,
    requireFresh = false,
  }: { fromDisk?: boolean; requireFresh?: boolean } = {}): Promise<VaultDocument> {
    if (this.document && !fromDisk) return this.document;

    let document: VaultDocument = { ...EMPTY_DOCUMENT, tokens: {} };
    try {
      const raw = await this.file.read();
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<VaultDocument>;
        document = {
          version: 1,
          environment: parsed.environment,
          tokens: typeof parsed.tokens === 'object' && parsed.tokens ? parsed.tokens : {},
        };
      }
    } catch (err) {
      if (requireFresh) {
        this.logger.warn('AUTH: fresh vault comparison unavailable; preserving stored credentials');
        throw err;
      }
      // A re-read that fails keeps the copy already in hand rather than "starting empty", which
      // a following write would persist as a wipe of every environment.
      if (this.document) {
        this.logger.warn(
          `AUTH: vault file re-read failed, using the copy in memory: ${err instanceof Error ? err.message : 'unknown'}`
        );
        return this.document;
      }
      this.logger.warn(
        `AUTH: vault file unreadable, starting empty: ${err instanceof Error ? err.message : 'unknown'}`
      );
    }

    this.document = document;
    return document;
  }

  private async persist(document: VaultDocument): Promise<void> {
    try {
      await this.file.write(JSON.stringify(document, null, 2));
    } catch (err) {
      // Non-fatal: the in-memory cache keeps this session working, and reporting the failure
      // through the logger beats throwing out of a token refresh.
      this.logger.error('AUTH: failed to write the credential vault', err);
    }
  }
}
