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
    const document = await this.load();
    document.environment = environment;
    await this.persist(document);
  }

  async getTokens(envUrl: string): Promise<AuthTokens | null> {
    const key = normalizeEnvKey(envUrl);
    const cached = this.cache.get(key);
    if (cached) return cached;

    if (this.storageStatus() === 'unavailable') return null;

    const blob = (await this.load()).tokens[key];
    if (!blob) return null;

    try {
      const parsed: unknown = JSON.parse(this.cipher.decryptString(Buffer.from(blob, 'base64')));
      if (!isAuthTokens(parsed)) throw new Error('unexpected token shape');
      this.cache.set(key, parsed);
      return parsed;
    } catch (err) {
      // A blob written under a different OS user, a rotated keychain entry, or a truncated
      // write. Drop it rather than wedging the app in a state it can never leave.
      this.logger.warn(`AUTH: discarding unreadable stored credentials for ${key}`);
      this.logger.debug(`AUTH: vault decrypt failed: ${err instanceof Error ? err.name : 'unknown'}`);
      await this.clearTokens(envUrl);
      return null;
    }
  }

  async setTokens(envUrl: string, tokens: AuthTokens): Promise<void> {
    const key = normalizeEnvKey(envUrl);
    this.cache.set(key, tokens);

    if (this.storageStatus() === 'unavailable') return;

    const document = await this.load();
    document.tokens[key] = this.cipher.encryptString(JSON.stringify(tokens)).toString('base64');
    await this.persist(document);
  }

  async clearTokens(envUrl: string): Promise<void> {
    const key = normalizeEnvKey(envUrl);
    this.cache.delete(key);

    const document = await this.load();
    if (!(key in document.tokens)) return;
    delete document.tokens[key];
    await this.persist(document);
  }

  /** A {@link TokenStore} bound to one environment, for the shared auth package to consume. */
  storeFor(envUrl: string): TokenStore {
    return {
      getAuthTokens: () => this.getTokens(envUrl),
      setAuthTokens: tokens => this.setTokens(envUrl, tokens),
      clearAuthTokens: () => this.clearTokens(envUrl),
      isAuthenticated: async () => (await this.getTokens(envUrl)) !== null,
    };
  }

  private async load(): Promise<VaultDocument> {
    if (this.document) return this.document;

    let document = { ...EMPTY_DOCUMENT, tokens: {} };
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
