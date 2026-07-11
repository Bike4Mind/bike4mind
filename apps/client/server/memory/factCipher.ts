import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Principal } from '@bike4mind/memory';

/**
 * Fact encryption for Mementos 2.0 crypto-shred. Facts are stored AES-256-GCM ciphertext under a
 * per-principal data-encryption key (DEK); "delete my data" destroys the DEK, after which the
 * ciphertext - including any in old backups - is permanently unreadable, while the ledger's hash
 * chain still verifies (it binds commitments, not plaintext). The core stays plaintext-only; all of
 * this lives at the persistence boundary.
 */

export interface SealedFact {
  cipher: string;
  iv: string;
  tag: string;
}

/** Encrypt a plaintext fact under a 32-byte DEK. */
export function encryptFact(dek: Buffer, plaintext: string): SealedFact {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  const cipher = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { cipher: cipher.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

/** Decrypt a sealed fact, or return null when the key is wrong/destroyed or the ciphertext was altered. */
export function decryptFact(dek: Buffer, sealed: SealedFact): string | null {
  try {
    const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(sealed.iv, 'base64'));
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(sealed.cipher, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The keyring surface this provider needs; `memoryPrincipalKeyRepository` satisfies it. */
export interface Keyring {
  getOrCreate(
    principalKind: Principal['kind'],
    principalId: string,
    ownerUserId: string,
    candidateDek: string
  ): Promise<string>;
  findDek(principalKind: Principal['kind'], principalId: string): Promise<string | null>;
  destroy(principalKind: Principal['kind'], principalId: string): Promise<void>;
}

export interface KeyProvider {
  /** The principal's DEK, minting one on first use. */
  getOrCreateDek(principal: Principal, ownerUserId: string): Promise<Buffer>;
  /** The principal's DEK, or null once destroyed. */
  getDek(principal: Principal): Promise<Buffer | null>;
  /** Destroy the principal's DEK - the irreversible crypto-shred. */
  destroyDek(principal: Principal): Promise<void>;
}

// Stored DEKs are prefixed so a value can be unwrapped correctly regardless of whether the master
// secret is configured now, avoiding config-drift corruption: `enc:` is envelope-wrapped, `raw:` is not.
const ENC = 'enc:';
const RAW = 'raw:';

/** Envelope-wrap a DEK under the master key: base64(iv|tag|ciphertext), prefixed. */
function wrapDek(masterKey: Buffer, dek: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return ENC + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function unwrapDek(masterKey: Buffer | undefined, stored: string): Buffer {
  if (stored.startsWith(RAW)) return Buffer.from(stored.slice(RAW.length), 'base64');
  if (stored.startsWith(ENC)) {
    if (!masterKey) throw new Error('memory keyring: envelope-wrapped DEK but no master key configured');
    const buf = Buffer.from(stored.slice(ENC.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const d = createDecipheriv('aes-256-gcm', masterKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }
  // Legacy/unprefixed: treat as raw base64.
  return Buffer.from(stored, 'base64');
}

/** Resolve the optional master key (envelope encryption) from the environment, or undefined. */
export function resolveMasterKey(secret = process.env.MEMORY_KEY_SECRET): Buffer | undefined {
  return secret ? createHash('sha256').update(secret).digest() : undefined;
}

/**
 * A KeyProvider backed by a keyring. If `masterKey` is set, DEKs are envelope-wrapped at rest so a
 * DB dump alone cannot read facts; without it (dev), DEKs are stored raw - still shred-safe, since
 * deletion destroys the key, but not confidential against a full DB read.
 */
export function createKeyProvider(keyring: Keyring, masterKey = resolveMasterKey()): KeyProvider {
  const store = (dek: Buffer): string => (masterKey ? wrapDek(masterKey, dek) : RAW + dek.toString('base64'));
  return {
    async getOrCreateDek(principal, ownerUserId) {
      const stored = await keyring.getOrCreate(principal.kind, principal.id, ownerUserId, store(randomBytes(32)));
      return unwrapDek(masterKey, stored);
    },
    async getDek(principal) {
      const stored = await keyring.findDek(principal.kind, principal.id);
      return stored ? unwrapDek(masterKey, stored) : null;
    },
    async destroyDek(principal) {
      await keyring.destroy(principal.kind, principal.id);
    },
  };
}
