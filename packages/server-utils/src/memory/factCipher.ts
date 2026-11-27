import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { Resource } from 'sst';
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

/**
 * A subject is `subjectKey(fact)` - the normalized content words of the fact - so storing it in
 * plaintext would leak what a shredded fact was about. Instead store an HMAC of it under a key
 * derived from the principal's DEK: opaque (irreversible, no content leak), deterministic (the same
 * fact for the same principal yields the same HMAC, so coalescence still works), and shredded along
 * with the fact when the DEK is destroyed. A separate derived key keeps subject-HMAC and fact-
 * encryption cryptographically independent.
 */
export function subjectHmac(dek: Buffer, subjectKey: string): string {
  const derived = createHmac('sha256', dek).update('mementos-2.0/subject-hmac/v1').digest();
  return createHmac('sha256', derived).update(subjectKey).digest('hex');
}

/**
 * Encrypt a belief's embedding under the SAME per-principal DEK as its fact.
 *
 * An embedding must never be stored in plaintext: it is a dense semantic image of the fact, and
 * embedding-inversion can approximately reconstruct the source text from it. Left in the clear it
 * would survive the crypto-shred as a recoverable fingerprint of the very fact we destroyed - the
 * same leak `subjectHmac` exists to prevent. Sharing the fact's DEK means destroying that one key
 * makes the fact AND its embedding unreadable together.
 *
 * The vector is packed as Float32 (not JSON) so the ciphertext stays compact - ~6KB for a 1536-dim
 * embedding rather than ~30KB. Embeddings are float32 at the source and cosine is insensitive to the
 * rounding, so nothing meaningful is lost.
 */
export function encryptVector(dek: Buffer, vector: number[]): SealedFact {
  const bytes = Buffer.from(new Float32Array(vector).buffer);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  const cipher = Buffer.concat([c.update(bytes), c.final()]);
  return { cipher: cipher.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

/** Decrypt an embedding, or null when the key is wrong/destroyed or the ciphertext was altered. */
export function decryptVector(dek: Buffer, sealed: SealedFact): number[] | null {
  try {
    const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(sealed.iv, 'base64'));
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const buf = Buffer.concat([d.update(Buffer.from(sealed.cipher, 'base64')), d.final()]);
    if (buf.byteLength % 4 !== 0) return null;
    // Copy into a fresh buffer: Float32Array needs 4-byte alignment, and a pooled Buffer's byteOffset
    // is not guaranteed to be one. `new Uint8Array(buf)` already copies, so no second copy is needed.
    return Array.from(new Float32Array(new Uint8Array(buf).buffer));
  } catch {
    return null;
  }
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
    candidateDek: string,
    startedAt: Date
  ): Promise<string | null>;
  findDek(principalKind: Principal['kind'], principalId: string): Promise<string | null>;
  destroy(principalKind: Principal['kind'], principalId: string): Promise<void>;
}

export interface KeyProvider {
  /**
   * The principal's DEK, minting one on first use - or NULL when the key was crypto-shredded after
   * `startedAt`, meaning this unit of work predates an erase and must not write.
   *
   * `startedAt` is the moment the caller's work began, not the moment of this call: a run's lease
   * claim, a request's arrival. See MemoryPrincipalKeyRepository.getOrCreate for why that is the
   * comparison that both refuses in-flight work and still lets a fresh rebuild re-key.
   */
  getOrCreateDek(principal: Principal, ownerUserId: string, startedAt: Date): Promise<Buffer | null>;
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
export function wrapDekUnder(masterKey: Buffer, dek: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return ENC + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** Wrap an existing raw data key without changing the key that encrypts its facts. */
export function rewrapLegacyDek(stored: string, masterKey: Buffer): string {
  if (stored.startsWith(ENC)) return stored;
  const dek = Buffer.from(stored.startsWith(RAW) ? stored.slice(RAW.length) : stored, 'base64');
  if (dek.length !== 32) throw new Error('Invalid memory data key');
  return wrapDekUnder(masterKey, dek);
}

function openEnc(masterKey: Buffer, stored: string): Buffer | null {
  const buf = Buffer.from(stored.slice(ENC.length), 'base64');
  try {
    const d = createDecipheriv('aes-256-gcm', masterKey, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  } catch {
    return null; // GCM tag mismatch: the value was wrapped under a different key
  }
}

/**
 * Opens an `enc:` value with the first of `keys` that authenticates it. Null when the value is not
 * `enc:` or no key opens it. `keyIndex` says which key did, so a rewrap can tell current from previous.
 */
export function openWrappedDek(stored: string, keys: Buffer[]): { dek: Buffer; keyIndex: number } | null {
  if (!stored.startsWith(ENC)) return null;
  for (const [keyIndex, key] of keys.entries()) {
    const dek = openEnc(key, stored);
    if (dek) return { dek, keyIndex };
  }
  return null;
}

function unwrapDek(keys: Buffer[], stored: string): Buffer {
  if (stored.startsWith(RAW)) return Buffer.from(stored.slice(RAW.length), 'base64');
  if (stored.startsWith(ENC)) {
    if (keys.length === 0) throw new Error('memory keyring: envelope-wrapped DEK but no master key configured');
    const opened = openWrappedDek(stored, keys);
    // Fail closed: an unopenable `enc:` value is never read as raw key bytes.
    if (!opened) throw new Error('memory keyring: wrapped DEK opens with no configured master key');
    return opened.dek;
  }
  // Legacy/unprefixed: treat as raw base64.
  return Buffer.from(stored, 'base64');
}

function deriveMasterKey(secret: string | undefined, name: string): Buffer | undefined {
  if (secret === undefined) {
    secret = process.env[name];
    if (!secret) {
      try {
        secret = (Resource as unknown as Record<string, { value?: string } | undefined>)[name]?.value;
      } catch {
        /* Unlinked in local development. */
      }
    }
  }
  if (!secret || secret === 'not-configured') return undefined;
  return createHash('sha256').update(secret).digest();
}

/** Resolve the optional master key (envelope encryption) from the environment, or undefined. */
export const resolveMasterKey = (secret?: string): Buffer | undefined => deriveMasterKey(secret, 'MEMORY_KEY_SECRET');

/** The outgoing master key while MEMORY_KEY_SECRET is being rotated; undefined in steady state. */
export const resolvePreviousMasterKey = (secret?: string): Buffer | undefined =>
  deriveMasterKey(secret, 'MEMORY_KEY_SECRET_PREVIOUS');

/**
 * True outside local dev - a raw DEK here is a real backup-confidentiality hole, not a dev
 * convenience. A preview/test stage is still a deployed stage: its database backups are real.
 */
const isDeployedEnv = (): boolean => {
  const stage = process.env.SST_STAGE ?? process.env.STAGE ?? '';
  return process.env.NODE_ENV === 'production' || (stage !== '' && !['dev', 'local', 'test'].includes(stage));
};

/**
 * A KeyProvider backed by a keyring. If `masterKey` is set (MEMORY_KEY_SECRET), DEKs are
 * envelope-wrapped at rest so a DB dump alone cannot read facts; without it (dev), DEKs are stored raw
 * - still SHRED-safe (deletion destroys the key), but NOT confidential against a full DB/backup read.
 *
 * `previousMasterKey` (MEMORY_KEY_SECRET_PREVIOUS) is read-only: it opens DEKs not yet rewrapped during a
 * rotation, and new DEKs are always wrapped under `masterKey`. Omit both key arguments to resolve
 * configuration; explicit key arguments are independent of the environment. See docs/security/credential-storage.md.
 *
 * Running a deployed stage without the secret voids the "unreadable even in backups" promise -
 * the raw DEK would sit next to the ciphertext - so MINTING a key refuses there. Reads refuse on
 * their own (`unwrapDek` cannot open a wrapped DEK without the key), and shredding never needs the
 * key at all: "delete my memory" must work even on a stage whose key is missing.
 */
export function createKeyProvider(
  keyring: Keyring,
  ...configuredKeys: [] | [masterKey: Buffer | undefined, previousMasterKey?: Buffer]
): KeyProvider {
  const masterKey = configuredKeys.length === 0 ? resolveMasterKey() : configuredKeys[0];
  const previousMasterKey = configuredKeys.length === 0 ? resolvePreviousMasterKey() : configuredKeys[1];
  const readKeys = [masterKey, previousMasterKey].filter((key): key is Buffer => key !== undefined);
  const store = (dek: Buffer): string => (masterKey ? wrapDekUnder(masterKey, dek) : RAW + dek.toString('base64'));
  return {
    async getOrCreateDek(principal, ownerUserId, startedAt) {
      if (!masterKey && isDeployedEnv()) {
        throw new Error('MEMORY_KEY_SECRET is required to mint memory principal keys in deployed stages');
      }
      const stored = await keyring.getOrCreate(
        principal.kind,
        principal.id,
        ownerUserId,
        store(randomBytes(32)),
        startedAt
      );
      return stored ? unwrapDek(readKeys, stored) : null;
    },
    async getDek(principal) {
      const stored = await keyring.findDek(principal.kind, principal.id);
      return stored ? unwrapDek(readKeys, stored) : null;
    },
    async destroyDek(principal) {
      await keyring.destroy(principal.kind, principal.id);
    },
  };
}
