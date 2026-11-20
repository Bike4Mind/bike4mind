import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeSignature,
  manifestSignatureMessage,
  parseUpdatePublicKeys,
  signatureFileName,
  verifyManifestSignature,
} from './manifestSignature';

const MANIFEST = Buffer.from('version: 0.2.3\nfiles:\n  - url: Bike4Mind-0.2.3-setup.exe\n    sha512: abc\n');

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, encoded: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

function signatureFor(name: string, manifest: Uint8Array, privateKey: KeyObject): string {
  return `${sign(null, manifestSignatureMessage(name, manifest), privateKey).toString('base64')}\n`;
}

function trusted(...encoded: string[]): KeyObject[] {
  const parsed = parseUpdatePublicKeys(encoded.join(','));
  if (parsed.kind !== 'keys') throw new Error(`expected keys, got ${parsed.kind}`);
  return parsed.keys;
}

describe('parseUpdatePublicKeys', () => {
  it('treats an unset or blank value as no keys', () => {
    for (const raw of [undefined, null, '', '  \n']) {
      expect(parseUpdatePublicKeys(raw)).toEqual({ kind: 'none' });
    }
  });

  it('parses every comma-separated entry, tolerating whitespace around them', () => {
    const first = keyPair();
    const second = keyPair();
    const parsed = parseUpdatePublicKeys(` ${first.encoded} ,\n${second.encoded} `);
    expect(parsed.kind).toBe('keys');
    expect(parsed.kind === 'keys' && parsed.keys).toHaveLength(2);
  });

  it('rejects the whole value when any one entry is malformed', () => {
    const valid = keyPair().encoded;
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    const x25519 = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    for (const bad of ['not-base64!', 'QUJDRA==', valid.slice(0, -4), rsa, x25519, '', `${valid}garbage`]) {
      const parsed = parseUpdatePublicKeys(`${valid},${bad}`);
      expect(parsed.kind, JSON.stringify(bad)).toBe('invalid');
      expect(parsed.kind === 'invalid' && parsed.reason).toBe(
        'B4M_UPDATE_PUBLIC_KEYS entry 2 is not a base64 Ed25519 SPKI public key'
      );
    }
  });
});

describe('verifyManifestSignature', () => {
  const signer = keyPair();
  const keys = trusted(signer.encoded);
  const signature = signatureFor('latest.yml', MANIFEST, signer.privateKey);

  it('accepts a signature made over this manifest and name by a listed key', () => {
    expect(verifyManifestSignature('latest.yml', MANIFEST, signature, keys)).toBe(true);
    expect(verifyManifestSignature('latest.yml', MANIFEST, signature.trimEnd(), keys)).toBe(true);
  });

  it('rejects a signature from a key that is not listed', () => {
    const other = keyPair();
    expect(verifyManifestSignature('latest.yml', MANIFEST, signature, trusted(other.encoded))).toBe(false);
  });

  it('rejects a manifest with any byte changed', () => {
    for (const index of [0, MANIFEST.length - 1]) {
      const tampered = Buffer.from(MANIFEST);
      tampered[index] ^= 1;
      expect(verifyManifestSignature('latest.yml', tampered, signature, keys)).toBe(false);
    }
    expect(verifyManifestSignature('latest.yml', Buffer.concat([MANIFEST, Buffer.from('\n')]), signature, keys)).toBe(
      false
    );
  });

  it('binds the manifest name, so one platform cannot stand in for another', () => {
    expect(verifyManifestSignature('latest-linux.yml', MANIFEST, signature, keys)).toBe(false);
    expect(verifyManifestSignature('latest-mac.yml', MANIFEST, signature, keys)).toBe(false);
  });

  it('rejects a missing or garbage signature', () => {
    for (const text of [null, '', '\n', 'garbage', 'QUJD\n', signature.replace(/[A-Z]/, '!')]) {
      expect(verifyManifestSignature('latest.yml', MANIFEST, text, keys)).toBe(false);
    }
  });

  it('verifies nothing against an empty key list', () => {
    expect(verifyManifestSignature('latest.yml', MANIFEST, signature, [])).toBe(false);
  });

  it('accepts a signature from any listed key, so a key can be rotated', () => {
    const next = keyPair();
    const both = trusted(signer.encoded, next.encoded);
    const fromNext = signatureFor('latest.yml', MANIFEST, next.privateKey);
    expect(verifyManifestSignature('latest.yml', MANIFEST, signature, both)).toBe(true);
    expect(verifyManifestSignature('latest.yml', MANIFEST, fromNext, both)).toBe(true);
    expect(verifyManifestSignature('latest.yml', MANIFEST, fromNext, keys)).toBe(false);
  });
});

describe('manifest framing', () => {
  it('frames the context, the name and the raw bytes', () => {
    expect(manifestSignatureMessage('latest-mac.yml', Buffer.from('a: 1\n')).toString()).toBe(
      'b4m-desktop-update-manifest-v1\nlatest-mac.yml\na: 1\n'
    );
    expect(signatureFileName('latest-linux-arm64.yml')).toBe('latest-linux-arm64.yml.sig');
  });

  it('refuses names that could blur the boundary between name and manifest', () => {
    for (const name of ['latest\n.yml', 'a/latest.yml', '../latest.yml', 'latest.yaml', '', '.yml']) {
      expect(() => manifestSignatureMessage(name, MANIFEST), JSON.stringify(name)).toThrow(/Not an update manifest/);
    }
  });

  it('decodes only a 64-byte base64 signature', () => {
    expect(decodeSignature(`${Buffer.alloc(64, 1).toString('base64')}\n`)).toHaveLength(64);
    expect(decodeSignature(Buffer.alloc(63, 1).toString('base64'))).toBeNull();
    expect(decodeSignature(Buffer.alloc(65, 1).toString('base64'))).toBeNull();
  });
});
