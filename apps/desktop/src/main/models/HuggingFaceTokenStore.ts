import { z } from 'zod';
import type { SecretCipher, StoreFile, StoreLogger } from '../chat/mcp/McpServerStore';

const tokenDocumentSchema = z.object({ version: z.literal(1), token: z.string().optional() });
type TokenCipher = SecretCipher & { getSelectedStorageBackend?: () => string };

/** The token stays in memory when the OS has no secure secret store. */
export class HuggingFaceTokenStore {
  #ready: Promise<void> | null = null;
  #token: string | null = null;

  constructor(
    private readonly cipher: TokenCipher,
    private readonly file: StoreFile,
    private readonly logger: StoreLogger
  ) {}

  persisted(): boolean {
    // Linux's basic_text backend encrypts with a hardcoded password, not an OS secret.
    return this.cipher.isEncryptionAvailable() && this.cipher.getSelectedStorageBackend?.() !== 'basic_text';
  }

  async #ensureLoaded(): Promise<void> {
    try {
      await (this.#ready ??= this.#load());
    } catch (error) {
      this.#ready = null;
      throw error;
    }
  }

  async get(): Promise<string | null> {
    await this.#ensureLoaded();
    return this.#token;
  }

  async set(token: string): Promise<void> {
    await this.#ensureLoaded();
    const document = this.persisted()
      ? { version: 1, token: this.cipher.encryptString(token).toString('base64') }
      : { version: 1 };
    await this.file.write(JSON.stringify(document));
    this.#token = token;
  }

  async clear(): Promise<void> {
    await this.#ensureLoaded();
    await this.file.write(JSON.stringify({ version: 1 }));
    this.#token = null;
  }

  async #load(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.file.read();
    } catch {
      this.logger.warn('Models: could not read the Hugging Face token file');
      throw new Error('Could not read the saved Hugging Face token. Try again.');
    }
    if (!raw || !this.persisted()) return;
    try {
      const stored = tokenDocumentSchema.parse(JSON.parse(raw));
      if (!stored.token) return;
      const token = this.cipher.decryptString(Buffer.from(stored.token, 'base64')).trim();
      if (token) this.#token = token;
    } catch (err) {
      this.logger.warn('Models: could not read the stored Hugging Face token');
      this.logger.debug(`Models: token read failed: ${err instanceof Error ? err.name : 'unknown'}`);
    }
  }
}
