import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CURATED_MAX_MANIFEST_BYTES,
  CURATED_MAX_SEQUENCE,
  CURATED_SIGNATURE_DOMAIN,
  curatedKeyFromSeed,
  curatedKeyId,
  curatedPublicKey,
  curatedSignedMessage,
  parseCuratedKey,
  parseCuratedSignatureFile,
  signCurated,
  verifyCurated,
  type CuratedKey,
  type CuratedKeyRole,
} from './curatedSignature';

const encode = (text: string) => new TextEncoder().encode(text);
const MANIFEST = encode('{"schemaVersion":2,"sequence":3}\n');

function keyPair(role: CuratedKeyRole): { key: CuratedKey; privateKey: KeyObject } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { key: { ...curatedPublicKey(privateKey), role }, privateKey };
}

const sigFile = (entries: { keyId: string; sig: string }[], sequence?: number) =>
  encode(JSON.stringify({ ...(sequence === undefined ? {} : { sequence }), signatures: entries }));

const signed = (manifest: Uint8Array, ...pairs: { key: CuratedKey; privateKey: KeyObject }[]) =>
  sigFile(pairs.map(pair => ({ keyId: pair.key.keyId, sig: signCurated(manifest, pair.privateKey) })));

describe('verifyCurated', () => {
  const signing = keyPair('signing');
  const recovery = keyPair('recovery');
  const keys = [signing.key, recovery.key];

  it('accepts a signing or a recovery signature and names the keys that verified', () => {
    expect(verifyCurated(MANIFEST, signed(MANIFEST, signing), keys)).toEqual({ ok: true, keys: [signing.key] });
    expect(verifyCurated(MANIFEST, signed(MANIFEST, recovery), keys)).toEqual({ ok: true, keys: [recovery.key] });
    expect(verifyCurated(MANIFEST, signed(MANIFEST, signing, recovery), keys)).toEqual({
      ok: true,
      keys: [signing.key, recovery.key],
    });
  });

  it('accepts a file whose only known entry is the second one', () => {
    const stranger = keyPair('signing');
    expect(verifyCurated(MANIFEST, signed(MANIFEST, stranger, signing), keys)).toMatchObject({ ok: true });
  });

  it.each([
    ['a flipped manifest byte', (m: Uint8Array) => m.map((b, i) => (i === 5 ? b ^ 1 : b))],
    ['an added trailing newline', (m: Uint8Array) => new Uint8Array([...m, 10])],
  ])('rejects %s', (_label, tamper) => {
    expect(verifyCurated(tamper(MANIFEST), signed(MANIFEST, signing), keys)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a flipped signature byte', () => {
    const sig = Buffer.from(signCurated(MANIFEST, signing.privateKey), 'base64');
    sig[0] ^= 1;
    expect(
      verifyCurated(MANIFEST, sigFile([{ keyId: signing.key.keyId, sig: sig.toString('base64') }]), keys)
    ).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it.each([
    ['no domain prefix', Buffer.alloc(0)],
    ['the v3 domain', Buffer.from('b4m-model-hub-curated-v3\n')],
  ])('rejects a signature made with %s', (_label, prefix) => {
    const sig = sign(null, Buffer.concat([prefix, MANIFEST]), signing.privateKey).toString('base64');
    expect(verifyCurated(MANIFEST, sigFile([{ keyId: signing.key.keyId, sig }]), keys)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('signs the domain and the raw sha256 of the manifest, 64 bytes whatever the list size', () => {
    const digest = createHash('sha256').update(MANIFEST).digest();
    const statement = curatedSignedMessage(MANIFEST);
    expect(CURATED_SIGNATURE_DOMAIN).toBe('b4m-model-hub-curated-v2-digest\n');
    expect(statement).toEqual(Buffer.concat([Buffer.from(CURATED_SIGNATURE_DOMAIN), digest]));
    expect(curatedSignedMessage(new Uint8Array(CURATED_MAX_MANIFEST_BYTES))).toHaveLength(64);
  });

  it('accepts a signature any Ed25519 signer made over the statement, as a KMS key signing it raw would', () => {
    const statement = Buffer.concat([
      Buffer.from('b4m-model-hub-curated-v2-digest\n'),
      createHash('sha256').update(MANIFEST).digest(),
    ]);
    const sig = sign(null, statement, signing.privateKey).toString('base64');
    expect(verifyCurated(MANIFEST, sigFile([{ keyId: signing.key.keyId, sig }]), keys)).toMatchObject({ ok: true });
  });

  it.each([
    ['the raw bytes under the old domain', () => Buffer.concat([Buffer.from('b4m-model-hub-curated-v2\n'), MANIFEST])],
    ['the raw bytes under the digest domain', () => Buffer.concat([Buffer.from(CURATED_SIGNATURE_DOMAIN), MANIFEST])],
    ['the bare digest', () => createHash('sha256').update(MANIFEST).digest()],
    [
      'the digest under the old domain',
      () => Buffer.concat([Buffer.from('b4m-model-hub-curated-v2\n'), createHash('sha256').update(MANIFEST).digest()]),
    ],
    [
      'the hex digest under the digest domain',
      () => Buffer.from(`${CURATED_SIGNATURE_DOMAIN}${createHash('sha256').update(MANIFEST).digest('hex')}`),
    ],
  ])('rejects a signature over %s', (_label, message) => {
    const sig = sign(null, message(), signing.privateKey).toString('base64');
    expect(verifyCurated(MANIFEST, sigFile([{ keyId: signing.key.keyId, sig }]), keys)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('checks each entry against the key its id names, among several trusted keys', () => {
    const second = keyPair('signing');
    const ring = [signing.key, second.key, recovery.key];
    expect(verifyCurated(MANIFEST, signed(MANIFEST, second), ring)).toEqual({ ok: true, keys: [second.key] });
    const swapped = sigFile([{ keyId: signing.key.keyId, sig: signCurated(MANIFEST, second.privateKey) }]);
    expect(verifyCurated(MANIFEST, swapped, ring)).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('accepts a list co-signed by a revoked and an active key under the active key only', () => {
    const second = keyPair('signing');
    const ring = [signing.key, second.key];
    expect(verifyCurated(MANIFEST, signed(MANIFEST, signing, second), ring, new Set([signing.key.keyId]))).toEqual({
      ok: true,
      keys: [second.key],
    });
  });

  it('rejects an unknown key id, and a known id carrying another key signature', () => {
    const stranger = keyPair('signing');
    expect(verifyCurated(MANIFEST, signed(MANIFEST, stranger), keys)).toMatchObject({
      ok: false,
      reason: 'unknown-key',
    });
    const forged = sigFile([{ keyId: signing.key.keyId, sig: signCurated(MANIFEST, stranger.privateKey) }]);
    expect(verifyCurated(MANIFEST, forged, keys)).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('skips a revoked signing key but never a recovery key', () => {
    const revoked = new Set([signing.key.keyId, recovery.key.keyId]);
    expect(verifyCurated(MANIFEST, signed(MANIFEST, signing), keys, revoked)).toMatchObject({
      ok: false,
      reason: 'revoked-key',
    });
    expect(verifyCurated(MANIFEST, signed(MANIFEST, recovery), keys, revoked)).toMatchObject({ ok: true });
  });

  it('rejects oversize inputs and malformed signature files before verifying', () => {
    const big = new Uint8Array(CURATED_MAX_MANIFEST_BYTES + 1);
    expect(verifyCurated(big, signed(MANIFEST, signing), keys)).toMatchObject({ ok: false, reason: 'oversize' });
    expect(verifyCurated(MANIFEST, new Uint8Array(8 * 1024 + 1), keys)).toMatchObject({
      ok: false,
      reason: 'oversize',
    });
    for (const bad of ['not json', '{}', '{"signatures":[]}', '<html></html>'])
      expect(verifyCurated(MANIFEST, encode(bad), keys)).toMatchObject({
        ok: false,
        reason: 'malformed-signature-file',
      });
  });
});

describe('keys and signature files', () => {
  it('derives the key id from the raw key and rejects entries whose id or role does not match', () => {
    const { key } = keyPair('signing');
    const raw = Buffer.from(key.spki, 'base64').subarray(12);
    expect(key.keyId).toBe(createHash('sha256').update(raw).digest('hex').slice(0, 16));
    expect(parseCuratedKey(key)).toEqual(key);
    expect(parseCuratedKey({ ...key, keyId: '0000000000000000' })).toBeNull();
    expect(parseCuratedKey({ ...key, role: 'admin' })).toBeNull();
    expect(curatedKeyId(Buffer.alloc(44).toString('base64'))).toBeNull();
  });

  it('reads the sequence hint and ignores unknown fields', () => {
    const file = encode(
      JSON.stringify({ sequence: 9, extra: true, signatures: [{ keyId: 'a'.repeat(16), sig: 'x' }] })
    );
    expect(parseCuratedSignatureFile(file)).toEqual({ sequence: 9, signatures: [{ keyId: 'a'.repeat(16), sig: 'x' }] });
  });

  it('caps the sequence hint at the list sequence cap', () => {
    const hint = (sequence: number) =>
      parseCuratedSignatureFile(
        encode(JSON.stringify({ sequence, signatures: [{ keyId: 'a'.repeat(16), sig: 'x' }] }))
      );
    expect(CURATED_MAX_SEQUENCE).toBe(1_000_000);
    expect(hint(1_000_000)?.sequence).toBe(1_000_000);
    expect(hint(1_000_001)).toBeNull();
  });

  it('imports a seed as the same key every time', () => {
    const seed = createHash('sha256').update('seed').digest();
    const first = curatedKeyFromSeed(seed);
    expect(curatedKeyFromSeed(seed).keyId).toBe(first.keyId);
    const key: CuratedKey = { keyId: first.keyId, spki: first.spki, role: 'signing' };
    const sig = sigFile([{ keyId: first.keyId, sig: signCurated(MANIFEST, first.privateKey) }]);
    expect(verifyCurated(MANIFEST, sig, [key])).toMatchObject({ ok: true });
  });
});
