import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Detached Ed25519 signatures over the update manifests (latest.yml, latest-mac.yml, latest-linux.yml).
 *
 * The signed message is this context line, the manifest's file name and then the manifest bytes exactly
 * as published, so a signature made for one platform's manifest never verifies as another's.
 * Must stay in sync with scripts/sign-update-manifests.mjs, which writes the `.sig` files in CI;
 * signUpdateManifests.test.ts signs with that script and verifies here.
 */
export const MANIFEST_SIGNATURE_CONTEXT = 'b4m-desktop-update-manifest-v1';

const MANIFEST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.yml$/;
const SIGNATURE_BYTES = 64;

// Buffer.from(..., 'base64') skips characters it does not recognise, so the shape is checked first.
function isBase64(text: string): boolean {
  return text.length > 0 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

export type UpdateKeys = { kind: 'none' } | { kind: 'keys'; keys: KeyObject[] } | { kind: 'invalid'; reason: string };

/**
 * The keys baked in from B4M_UPDATE_PUBLIC_KEYS: comma-separated base64 SPKI DER, Ed25519 only.
 *
 * One entry that does not parse makes the whole value invalid rather than the list shorter, so a
 * typo can never leave a build trusting fewer keys than intended, or none at all.
 */
export function parseUpdatePublicKeys(raw: string | undefined | null): UpdateKeys {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { kind: 'none' };

  const keys: KeyObject[] = [];
  for (const [index, entry] of trimmed.split(',').entries()) {
    const key = parsePublicKey(entry.trim());
    if (!key) {
      return {
        kind: 'invalid',
        reason: `B4M_UPDATE_PUBLIC_KEYS entry ${index + 1} is not a base64 Ed25519 SPKI public key`,
      };
    }
    keys.push(key);
  }
  return { kind: 'keys', keys };
}

function parsePublicKey(text: string): KeyObject | null {
  if (!isBase64(text)) return null;
  const der = Buffer.from(text, 'base64');
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return key.export({ format: 'der', type: 'spki' }).equals(der) ? key : null;
  } catch {
    return null;
  }
}

export function signatureFileName(manifestName: string): string {
  return `${manifestName}.sig`;
}

export function manifestSignatureMessage(manifestName: string, manifest: Uint8Array): Buffer {
  // The name is newline-delimited inside the message, so it must never contain one.
  if (!MANIFEST_NAME.test(manifestName)) {
    throw new Error(`Not an update manifest name: ${JSON.stringify(manifestName)}`);
  }
  return Buffer.concat([Buffer.from(`${MANIFEST_SIGNATURE_CONTEXT}\n${manifestName}\n`, 'utf8'), manifest]);
}

/** The signature bytes from a `.sig` file's text, or null when it is not one base64 Ed25519 signature. */
export function decodeSignature(text: string): Buffer | null {
  const body = text.trim();
  if (!isBase64(body)) return null;
  const signature = Buffer.from(body, 'base64');
  return signature.length === SIGNATURE_BYTES ? signature : null;
}

/** True when `signatureText` verifies over this manifest under any one of `keys`. */
export function verifyManifestSignature(
  manifestName: string,
  manifest: Uint8Array,
  signatureText: string | null,
  keys: readonly KeyObject[]
): boolean {
  if (signatureText === null) return false;
  const signature = decodeSignature(signatureText);
  if (!signature) return false;
  const message = manifestSignatureMessage(manifestName, manifest);
  return keys.some(key => verify(null, message, key, signature));
}
