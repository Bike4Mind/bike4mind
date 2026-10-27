import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

/** Prefixed to the manifest bytes before signing, so a signature over another kind of file never verifies here. */
export const CURATED_SIGNATURE_DOMAIN = 'b4m-model-hub-curated-v2\n';
export const CURATED_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const CURATED_MAX_SIGNATURE_BYTES = 8 * 1024;
/** Must equal HUB_MAX_SEQUENCE in @bike4mind/common (schemas/modelHub.ts); this package does not depend on it. */
export const CURATED_MAX_SEQUENCE = 1_000_000;
const MAX_SIGNATURES = 4;

// DER headers of an Ed25519 SubjectPublicKeyInfo and of a PKCS8 private key around a 32-byte seed.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const KEY_BYTES = 32;

export const CURATED_KEY_ROLES = ['signing', 'recovery'] as const;
export type CuratedKeyRole = (typeof CURATED_KEY_ROLES)[number];

/** A trusted public key: base64 SPKI DER, its id, and whether it may revoke other keys. */
export interface CuratedKey {
  keyId: string;
  spki: string;
  role: CuratedKeyRole;
}

export interface CuratedSignatureEntry {
  keyId: string;
  sig: string;
}

export interface CuratedSignatureFile {
  /** Unsigned hint naming the immutable pair to fall back to; never trusted on its own. */
  sequence: number | null;
  signatures: CuratedSignatureEntry[];
}

export type CuratedVerifyFailure =
  'oversize' | 'malformed-signature-file' | 'unknown-key' | 'revoked-key' | 'bad-signature';

export type CuratedVerifyResult =
  { ok: true; keys: CuratedKey[] } | { ok: false; reason: CuratedVerifyFailure; detail: string };

const KeyIdSchema = z.string().regex(/^[0-9a-f]{16}$/);
const SignatureFileSchema = z.object({
  sequence: z.number().int().min(1).max(CURATED_MAX_SEQUENCE).optional(),
  signatures: z
    .array(z.object({ keyId: KeyIdSchema, sig: z.string().max(128) }))
    .min(1)
    .max(MAX_SIGNATURES),
});

function rawPublicKey(spki: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(spki)) return null;
  const der = Buffer.from(spki, 'base64');
  if (der.length !== SPKI_PREFIX.length + KEY_BYTES || !der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX))
    return null;
  return der.subarray(SPKI_PREFIX.length);
}

/** First 16 hex characters of sha256 over the raw 32-byte key; null when `spki` is not an Ed25519 SPKI. */
export function curatedKeyId(spki: string): string | null {
  const raw = rawPublicKey(spki);
  return raw ? createHash('sha256').update(raw).digest('hex').slice(0, 16) : null;
}

/** A keyring entry, or null unless its SPKI is Ed25519, its id matches the key and its role is known. */
export function parseCuratedKey(value: unknown): CuratedKey | null {
  if (typeof value !== 'object' || value === null) return null;
  const { keyId, spki, role } = value as Record<string, unknown>;
  if (typeof spki !== 'string' || typeof keyId !== 'string') return null;
  if (!(CURATED_KEY_ROLES as readonly unknown[]).includes(role)) return null;
  return curatedKeyId(spki) === keyId ? { keyId, spki, role: role as CuratedKeyRole } : null;
}

/** The signature file's entries and sequence hint, or null when it is not one; unknown fields are ignored. */
export function parseCuratedSignatureFile(bytes: Uint8Array): CuratedSignatureFile | null {
  if (bytes.byteLength > CURATED_MAX_SIGNATURE_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const parsed = SignatureFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { sequence: parsed.data.sequence ?? null, signatures: parsed.data.signatures };
}

export function curatedSignedMessage(manifest: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(CURATED_SIGNATURE_DOMAIN, 'utf8'), manifest]);
}

function signatureBytes(sig: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) return null;
  const bytes = Buffer.from(sig, 'base64');
  return bytes.length === 64 ? bytes : null;
}

/**
 * Accepts when at least one entry names a key in `keys` that is not in `revoked` and its Ed25519 signature over the
 * domain-prefixed raw bytes verifies; other entries are ignored. A recovery key is never treated as revoked.
 */
export function verifyCurated(
  manifest: Uint8Array,
  signatureFile: Uint8Array,
  keys: readonly CuratedKey[],
  revoked: ReadonlySet<string> = new Set()
): CuratedVerifyResult {
  if (manifest.byteLength > CURATED_MAX_MANIFEST_BYTES)
    return { ok: false, reason: 'oversize', detail: `manifest is over ${CURATED_MAX_MANIFEST_BYTES} bytes` };
  if (signatureFile.byteLength > CURATED_MAX_SIGNATURE_BYTES)
    return { ok: false, reason: 'oversize', detail: `signature file is over ${CURATED_MAX_SIGNATURE_BYTES} bytes` };
  const file = parseCuratedSignatureFile(signatureFile);
  if (!file) return { ok: false, reason: 'malformed-signature-file', detail: 'signature file is not valid' };

  const message = curatedSignedMessage(manifest);
  const verified: CuratedKey[] = [];
  let known = false;
  let active = false;
  for (const entry of file.signatures) {
    const key = keys.find(candidate => candidate.keyId === entry.keyId);
    if (!key) continue;
    known = true;
    if (key.role !== 'recovery' && revoked.has(key.keyId)) continue;
    active = true;
    if (!verified.includes(key) && verifiesUnder(key, message, entry.sig)) verified.push(key);
  }
  if (verified.length > 0) return { ok: true, keys: verified };
  const ids = file.signatures.map(entry => entry.keyId).join(', ');
  if (!known) return { ok: false, reason: 'unknown-key', detail: `no signature is from a trusted key (${ids})` };
  if (!active) return { ok: false, reason: 'revoked-key', detail: `signed only by revoked keys (${ids})` };
  return { ok: false, reason: 'bad-signature', detail: `signature does not verify (${ids})` };
}

function verifiesUnder(key: CuratedKey, message: Buffer, sig: string): boolean {
  const bytes = signatureBytes(sig);
  if (!bytes) return false;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' });
    return verify(null, message, publicKey, bytes);
  } catch {
    return false;
  }
}

/** Base64 Ed25519 signature over the domain-prefixed bytes. */
export function signCurated(manifest: Uint8Array, privateKey: KeyObject): string {
  return sign(null, curatedSignedMessage(manifest), privateKey).toString('base64');
}

/** The base64 SPKI and key id of an Ed25519 public (or private) key. */
export function curatedPublicKey(key: KeyObject): { keyId: string; spki: string } {
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
  const keyId = curatedKeyId(spki);
  if (!keyId) throw new Error('not an Ed25519 key');
  return { keyId, spki };
}

/** Imports a 32-byte Ed25519 seed as a private key; only for keys whose seed is public on purpose. */
export function curatedKeyFromSeed(seed: Uint8Array): { privateKey: KeyObject; keyId: string; spki: string } {
  if (seed.byteLength !== KEY_BYTES) throw new Error('an Ed25519 seed is 32 bytes');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, ...curatedPublicKey(privateKey) };
}
