import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Starts every blob this cipher writes; safeStorage's start with "v10" or "v11". */
const MARKER = Buffer.from('b4m-sk1', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MARKER.length + NONCE_BYTES + TAG_BYTES;

export function isSecretKeyBlob(encrypted: Buffer): boolean {
  return encrypted.subarray(0, MARKER.length).equals(MARKER);
}

/**
 * AES-256-GCM under the app's own key, which is loaded on first use and kept for the process.
 * A blob is the marker, the nonce, the tag, then the ciphertext; the marker is also the AAD.
 */
export class SecretKeyCipher {
  private key: Buffer | null | undefined;

  constructor(private readonly loadKey: () => Buffer | null) {}

  isEncryptionAvailable(): boolean {
    return this.currentKey() !== null;
  }

  encryptString(plainText: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(MARKER);
    const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    return Buffer.concat([MARKER, nonce, cipher.getAuthTag(), body]);
  }

  decryptString(encrypted: Buffer): string {
    if (!isSecretKeyBlob(encrypted) || encrypted.length < HEADER_BYTES) {
      throw new Error('Not a secret-key blob.');
    }
    const nonce = encrypted.subarray(MARKER.length, MARKER.length + NONCE_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.requireKey(), nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(MARKER);
    decipher.setAuthTag(encrypted.subarray(MARKER.length + NONCE_BYTES, HEADER_BYTES));
    return Buffer.concat([decipher.update(encrypted.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
  }

  private currentKey(): Buffer | null {
    if (this.key === undefined) this.key = this.loadKey();
    return this.key;
  }

  private requireKey(): Buffer {
    const key = this.currentKey();
    if (!key) throw new Error('The secret key is not available.');
    return key;
  }
}
