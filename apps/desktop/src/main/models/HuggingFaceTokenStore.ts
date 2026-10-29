import type { SecretCipher, StoreFile, StoreLogger } from '../chat/mcp/McpServerStore';

interface TokenDocument {
  version: 1;
  /** base64 safeStorage ciphertext of the token. */
  token?: string;
}

/**
 * The user's Hugging Face access token, in the OS keychain through safeStorage, the same way
 * McpServerStore keeps MCP secrets. With no keyring (Linux without a secret service) it is held in
 * memory for this run and nothing is written, never plaintext; {@link persisted} says which.
 */
export class HuggingFaceTokenStore {
  #ready: Promise<void> | null = null;
  #token: string | null = null;

  constructor(
    private readonly cipher: SecretCipher,
    private readonly file: StoreFile,
    private readonly logger: StoreLogger
  ) {}

  persisted(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  async get(): Promise<string | null> {
    await (this.#ready ??= this.#load());
    return this.#token;
  }

  async set(token: string): Promise<void> {
    await (this.#ready ??= this.#load());
    const document: TokenDocument = this.persisted()
      ? { version: 1, token: this.cipher.encryptString(token).toString('base64') }
      : { version: 1 };
    await this.file.write(JSON.stringify(document));
    this.#token = token;
  }

  async clear(): Promise<void> {
    await (this.#ready ??= this.#load());
    await this.file.write(JSON.stringify({ version: 1 } satisfies TokenDocument));
    this.#token = null;
  }

  async #load(): Promise<void> {
    const raw = await this.file.read().catch(() => null);
    if (!raw || !this.persisted()) return;
    try {
      const stored = (JSON.parse(raw) as Partial<TokenDocument>).token;
      if (typeof stored !== 'string' || !stored) return;
      const token = this.cipher.decryptString(Buffer.from(stored, 'base64')).trim();
      if (token) this.#token = token;
    } catch (err) {
      // A blob from another OS user or a rotated keychain entry: dropped, and the screen shows "not set".
      this.logger.warn('Models: could not read the stored Hugging Face token');
      this.logger.debug(`Models: token read failed: ${err instanceof Error ? err.name : 'unknown'}`);
    }
  }
}
