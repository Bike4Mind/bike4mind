import type { FleetKeyStorage } from '@shared/fleet';
import type { SecretCipher, VaultFile } from '../auth/tokenVault';

interface SettingsDocument {
  version: 1;
  url?: string;
  consent?: boolean;
  /** base64 safeStorage ciphertext of the Fleet key. */
  key?: string;
}

export interface FleetSettings {
  url: string | null;
  consent: boolean;
  key: string | null;
}

export interface FleetSettingsLogger {
  warn(message: string): void;
}

/**
 * The Fleet URL, the consent flag and the key, in one file under userData.
 *
 * The key is encrypted with the OS keychain like the auth vault, and for the same reason: with
 * no keyring it is held in memory only and the card says so. It is never written in plaintext.
 */
export class FleetSettingsStore {
  private document: SettingsDocument | null = null;
  private memoryKey: string | null = null;

  constructor(
    private readonly cipher: SecretCipher,
    private readonly file: VaultFile,
    private readonly logger: FleetSettingsLogger
  ) {}

  keyStorage(): FleetKeyStorage {
    return this.cipher.isEncryptionAvailable() ? 'available' : 'unavailable';
  }

  async read(): Promise<FleetSettings> {
    const document = await this.load();
    return { url: document.url ?? null, consent: document.consent === true, key: await this.key(document) };
  }

  async setUrl(url: string | null): Promise<void> {
    const document = await this.load();
    if (url) document.url = url;
    else delete document.url;
    await this.persist(document);
  }

  async setConsent(consent: boolean): Promise<void> {
    const document = await this.load();
    document.consent = consent;
    await this.persist(document);
  }

  async setKey(key: string | null): Promise<void> {
    const document = await this.load();
    this.memoryKey = key;
    if (key && this.keyStorage() === 'available') {
      document.key = this.cipher.encryptString(key).toString('base64');
    } else {
      delete document.key;
    }
    await this.persist(document);
  }

  private async key(document: SettingsDocument): Promise<string | null> {
    if (this.memoryKey) return this.memoryKey;
    if (!document.key || this.keyStorage() === 'unavailable') return null;
    try {
      this.memoryKey = this.cipher.decryptString(Buffer.from(document.key, 'base64'));
      return this.memoryKey;
    } catch {
      this.logger.warn('FLEET: discarding an unreadable stored key');
      delete document.key;
      await this.persist(document);
      return null;
    }
  }

  private async load(): Promise<SettingsDocument> {
    if (this.document) return this.document;
    let document: SettingsDocument = { version: 1 };
    try {
      const raw = await this.file.read();
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SettingsDocument>;
        document = {
          version: 1,
          ...(typeof parsed.url === 'string' ? { url: parsed.url } : {}),
          ...(parsed.consent === true ? { consent: true } : {}),
          ...(typeof parsed.key === 'string' ? { key: parsed.key } : {}),
        };
      }
    } catch {
      this.logger.warn('FLEET: settings file unreadable, starting empty');
    }
    this.document = document;
    return document;
  }

  private async persist(document: SettingsDocument): Promise<void> {
    try {
      await this.file.write(JSON.stringify(document, null, 2));
    } catch (err) {
      this.logger.warn(`FLEET: failed to write settings: ${err instanceof Error ? err.name : 'unknown'}`);
    }
  }
}
