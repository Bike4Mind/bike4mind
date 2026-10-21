import { normalizeEnvKey, type AuthLogger, type AuthTokens, type TokenStore } from '@bike4mind/client-auth';
import type { EnvironmentSelection, TokenStorageStatus } from '@shared/auth';

/**
 * The slice of Electron's `safeStorage` this module needs. Narrowed to a port so the vault
 * can be tested without an Electron app, and so the "must be called after the app `ready`
 * event" rule stays a construction-order concern of the caller rather than an import-time
 * landmine here.
 */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

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

function isAuthTokens(value: unknown): value is AuthTokens {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accessToken === 'string' &&
    typeof candidate.refreshToken === 'string' &&
    typeof candidate.expiresAt === 'string' &&
    typeof candidate.userId === 'string'
  );
}

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
 *   say the session will not survive a restart. It never falls back to writing plaintext.
 */
export class TokenVault {
  private document: VaultDocument | null = null;
  /** Decrypted tokens by environment key; the only copy when encryption is unavailable. */
  private readonly cache = new Map<string, AuthTokens>();

  constructor(
    private readonly cipher: SecretCipher,
    private readonly file: VaultFile,
    private readonly logger: AuthLogger
  ) {}

  /** Cheap enough to re-ask each time, and the answer can change between launches. */
  storageStatus(): TokenStorageStatus {
    return this.cipher.isEncryptionAvailable() ? 'available' : 'unavailable';
  }

  async getEnvironment(): Promise<EnvironmentSelection | undefined> {
    return (await this.load()).environment;
  }

  async setEnvironment(environment: EnvironmentSelection): Promise<void> {
    const document = await this.load({ fromDisk: true });
    document.environment = environment;
    await this.persist(document);
  }

  async getTokens(envUrl: string): Promise<AuthTokens | null> {
    const key = normalizeEnvKey(envUrl);
    const cached = this.cache.get(key);
    if (cached) return cached;

    if (this.storageStatus() === 'unavailable') return null;
    return this.decryptInto(envUrl, await this.load());
  }

  /**
   * {@link getTokens}, but read from the file rather than the cache. Another process sharing this
   * `userData` (a second app instance, or a dev build next to the packaged one) rotates the same
   * refresh token, so anything about to present it must see that process's latest write.
   */
  async reloadTokens(envUrl: string): Promise<AuthTokens | null> {
    if (this.storageStatus() === 'unavailable') return this.cache.get(normalizeEnvKey(envUrl)) ?? null;
    return this.decryptInto(envUrl, await this.load({ fromDisk: true }), { keepCachedOnFailure: true });
  }

  async setTokens(envUrl: string, tokens: AuthTokens): Promise<void> {
    const key = normalizeEnvKey(envUrl);
    this.cache.set(key, tokens);

    if (this.storageStatus() === 'unavailable') return;

    const document = await this.load({ fromDisk: true });
    document.tokens[key] = this.cipher.encryptString(JSON.stringify(tokens)).toString('base64');
    await this.persist(document);
  }

  async clearTokens(envUrl: string): Promise<void> {
    const key = normalizeEnvKey(envUrl);
    this.cache.delete(key);

    const document = await this.load({ fromDisk: true });
    if (!(key in document.tokens)) return;
    delete document.tokens[key];
    await this.persist(document);
  }

  /** A {@link TokenStore} bound to one environment, for the shared auth package to consume. */
  storeFor(envUrl: string): TokenStore {
    return {
      getAuthTokens: () => this.getTokens(envUrl),
      reloadAuthTokens: () => this.reloadTokens(envUrl),
      setAuthTokens: tokens => this.setTokens(envUrl, tokens),
      clearAuthTokens: () => this.clearTokens(envUrl),
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
    { keepCachedOnFailure = false }: { keepCachedOnFailure?: boolean } = {}
  ): Promise<AuthTokens | null> {
    const key = normalizeEnvKey(envUrl);
    const blob = document.tokens[key];
    if (!blob) {
      this.cache.delete(key);
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(this.cipher.decryptString(Buffer.from(blob, 'base64')));
      if (!isAuthTokens(parsed)) throw new Error('unexpected token shape');
      this.cache.set(key, parsed);
      return parsed;
    } catch (err) {
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
      await this.clearTokens(envUrl);
      return null;
    }
  }

  /**
   * The vault document. Reads are served from memory; anything that writes, or must see another
   * process's latest tokens, passes `fromDisk` so it starts from the file as it is now - a
   * read-modify-write over a stale copy would put back tokens that process already replaced.
   */
  private async load({ fromDisk = false }: { fromDisk?: boolean } = {}): Promise<VaultDocument> {
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
