import { describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from '@bike4mind/memory';
import {
  createKeyProvider,
  decryptFact,
  decryptVector,
  encryptFact,
  encryptVector,
  subjectHmac,
  type Keyring,
} from './factCipher';

/**
 * In-memory keyring for the provider tests.
 *
 * Models the real repository's TOMBSTONE semantics, not a plain map: `destroy` unsets the key but
 * keeps a `destroyedAt`, and `getOrCreate` re-mints only when that stamp strictly predates the
 * caller's `startedAt`. A fake that merely deleted the entry would re-mint unconditionally and make
 * every fence test here pass for the wrong reason.
 */
function makeKeyring() {
  const store = new Map<string, string>();
  const destroyed = new Map<string, Date>();
  const k = (kind: string, id: string) => `${kind}:${id}`;
  const keyring: Keyring = {
    async getOrCreate(kind, id, _owner, candidate, startedAt) {
      const existing = store.get(k(kind, id));
      if (existing) return existing;
      const tombstone = destroyed.get(k(kind, id));
      if (tombstone && tombstone.getTime() >= startedAt.getTime()) return null;
      destroyed.delete(k(kind, id));
      store.set(k(kind, id), candidate);
      return candidate;
    },
    async findDek(kind, id) {
      return store.get(k(kind, id)) ?? null;
    },
    async destroy(kind, id) {
      store.delete(k(kind, id));
      destroyed.set(k(kind, id), new Date());
    },
  };
  return { keyring, store };
}

const WORK_STARTED = new Date('2026-01-01T00:00:00.000Z');

const user: Principal = { kind: 'user', id: 'u1' };

describe('encryptFact / decryptFact', () => {
  it('round-trips a plaintext under its key', () => {
    const dek = randomBytes(32);
    const sealed = encryptFact(dek, 'the user loves sushi');
    expect(decryptFact(dek, sealed)).toBe('the user loves sushi');
  });

  it('returns null under the wrong key (the crypto-shred guarantee)', () => {
    const sealed = encryptFact(randomBytes(32), 'secret');
    expect(decryptFact(randomBytes(32), sealed)).toBeNull();
  });

  it('returns null when the ciphertext is tampered (GCM auth fails)', () => {
    const dek = randomBytes(32);
    const sealed = encryptFact(dek, 'secret');
    expect(decryptFact(dek, { ...sealed, cipher: Buffer.from('tampered').toString('base64') })).toBeNull();
  });
});

describe('subjectHmac', () => {
  it('is deterministic per key (so re-mentions coalesce) and never contains the plaintext', () => {
    const dek = randomBytes(32);
    const a = subjectHmac(dek, 'love sushi');
    expect(subjectHmac(dek, 'love sushi')).toBe(a); // deterministic
    expect(a).not.toContain('sushi'); // opaque - no content leak
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across keys and across subjects', () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    expect(subjectHmac(k1, 'love sushi')).not.toBe(subjectHmac(k2, 'love sushi')); // per principal
    expect(subjectHmac(k1, 'love sushi')).not.toBe(subjectHmac(k1, 'hate sushi')); // per subject
  });
});

describe('createKeyProvider', () => {
  it('mints one stable key per principal and forgets it on destroy', async () => {
    const { keyring } = makeKeyring();
    const keys = createKeyProvider(keyring, undefined);
    const a = await keys.getOrCreateDek(user, 'u1', WORK_STARTED);
    const b = await keys.getOrCreateDek(user, 'u1', WORK_STARTED);
    expect(a.equals(b)).toBe(true); // stable
    expect((await keys.getDek(user))?.equals(a)).toBe(true);
    await keys.destroyDek(user);
    expect(await keys.getDek(user)).toBeNull();
  });

  it('envelope-wraps the DEK at rest when a master key is set, and still recovers it', async () => {
    const { keyring, store } = makeKeyring();
    const master = createHash('sha256').update('master-secret').digest();
    const keys = createKeyProvider(keyring, master);
    const dek = await keys.getOrCreateDek(user, 'u1', WORK_STARTED);
    // Stored value is wrapped, not the raw key.
    expect(store.get('user:u1')?.startsWith('enc:')).toBe(true);
    expect((await keys.getDek(user))?.equals(dek)).toBe(true);
  });

  it("threads the caller's startedAt through to the keyring, in the position the fence reads", async () => {
    // The load-bearing seam of the whole crypto-shred fence, and the one place a typecheck cannot help:
    // apps/client/tsconfig.json excludes test files, so dropping this argument compiles cleanly and the
    // fence silently stops applying for every production caller. Assert the exact position, not just
    // that a refusal is possible.
    const { keyring } = makeKeyring();
    const getOrCreate = vi.fn(keyring.getOrCreate);
    const keys = createKeyProvider({ ...keyring, getOrCreate }, undefined);

    const dek = await keys.getOrCreateDek(user, 'u1', WORK_STARTED);

    expect(dek).not.toBeNull();
    expect(getOrCreate).toHaveBeenCalledWith('user', 'u1', 'u1', expect.any(String), WORK_STARTED);
  });

  it('returns null when the key was shredded after the work began, and re-keys a later rebuild', async () => {
    // Both halves of the fence through the real provider: work that predates the shred must fail closed
    // (null, so the caller writes nothing), while a rebuild starting after it legitimately re-keys.
    const { keyring } = makeKeyring();
    const keys = createKeyProvider(keyring, undefined);
    await keys.getOrCreateDek(user, 'u1', WORK_STARTED);
    await keys.destroyDek(user);

    expect(await keys.getOrCreateDek(user, 'u1', WORK_STARTED)).toBeNull();
    expect(await keys.getOrCreateDek(user, 'u1', new Date(Date.now() + 60_000))).not.toBeNull();
  });

  it('encrypts a fact end-to-end through the provider key', async () => {
    const { keyring } = makeKeyring();
    const keys = createKeyProvider(keyring, undefined);
    const dek = await keys.getOrCreateDek(user, 'u1', WORK_STARTED);
    const sealed = encryptFact(dek, 'discovery calls');
    const fetched = await keys.getDek(user);
    expect(fetched && decryptFact(fetched, sealed)).toBe('discovery calls');
  });
});

describe('encryptVector / decryptVector', () => {
  const vec = [0.0125, -0.9, 0.5, 0.33333, -0.001];

  it('round-trips a vector under the principal DEK', () => {
    const dek = randomBytes(32);
    const out = decryptVector(dek, encryptVector(dek, vec));
    expect(out).not.toBeNull();
    expect(out).toHaveLength(vec.length);
    // Float32 packing keeps the ciphertext compact; cosine is insensitive to the rounding.
    out!.forEach((v, i) => expect(v).toBeCloseTo(vec[i], 5));
  });

  it('does not store the vector in the clear', () => {
    const dek = randomBytes(32);
    const sealed = encryptVector(dek, vec);
    const raw = Buffer.from(sealed.cipher, 'base64');
    // The plaintext Float32 bytes must not appear verbatim in the ciphertext.
    expect(raw.includes(Buffer.from(new Float32Array(vec).buffer))).toBe(false);
  });

  it('returns null under the WRONG key - this is what makes crypto-shred cover the embedding', () => {
    // An embedding is a semantic image of the fact (inversion can partially reconstruct the text),
    // so destroying the principal's DEK must render it unreadable exactly like the fact itself.
    const sealed = encryptVector(randomBytes(32), vec);
    expect(decryptVector(randomBytes(32), sealed)).toBeNull();
  });

  it('returns null on tampered ciphertext (GCM auth tag)', () => {
    const dek = randomBytes(32);
    const sealed = encryptVector(dek, vec);
    const bytes = Buffer.from(sealed.cipher, 'base64');
    bytes[0] ^= 0xff;
    expect(decryptVector(dek, { ...sealed, cipher: bytes.toString('base64') })).toBeNull();
  });
});
