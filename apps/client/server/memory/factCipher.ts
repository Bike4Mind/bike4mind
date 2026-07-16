import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
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

/** True outside local dev - a raw DEK here is a real backup-confidentiality hole, not a dev convenience. */
const isDeployedEnv = (): boolean => {
  const stage = process.env.SST_STAGE ?? process.env.STAGE ?? '';
  return process.env.NODE_ENV === 'production' && stage !== '' && !/^(dev|local|test)/i.test(stage);
};
let warnedNoMasterKey = false;

/**
 * A KeyProvider backed by a keyring. If `masterKey` is set (MEMORY_KEY_SECRET), DEKs are
 * envelope-wrapped at rest so a DB dump alone cannot read facts; without it (dev), DEKs are stored raw
 * - still SHRED-safe (deletion destroys the key), but NOT confidential against a full DB/backup read.
 *
 * Running a deployed stage without the secret silently voids the "unreadable even in backups" promise -
 * the raw DEK sits next to the ciphertext, so a pre-shred backup is fully recoverable. We do not hard
 * throw (that would take memory down on a misconfig), but we surface it LOUDLY via console.error once,
 * so it lands in error monitoring instead of degrading in silence.
 */
export function createKeyProvider(keyring: Keyring, masterKey = resolveMasterKey()): KeyProvider {
  if (!masterKey && !warnedNoMasterKey && isDeployedEnv()) {
    warnedNoMasterKey = true;
    console.error(
      '[memory] MEMORY_KEY_SECRET is not set in a deployed stage: principal keys are stored RAW next to ' +
        'the ciphertext, so a backup taken before a crypto-shred is fully recoverable. Set the secret to ' +
        'restore envelope-wrapping and the backup-unreadability guarantee.'
    );
  }
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
