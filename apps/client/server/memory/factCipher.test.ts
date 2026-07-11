import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from '@bike4mind/memory';
import { createKeyProvider, decryptFact, encryptFact, type Keyring } from './factCipher';

/** In-memory keyring for the provider tests. */
function makeKeyring() {
  const store = new Map<string, string>();
  const k = (kind: string, id: string) => `${kind}:${id}`;
  const keyring: Keyring = {
    async getOrCreate(kind, id, _owner, candidate) {
      const existing = store.get(k(kind, id));
      if (existing) return existing;
      store.set(k(kind, id), candidate);
      return candidate;
    },
    async findDek(kind, id) {
      return store.get(k(kind, id)) ?? null;
    },
    async destroy(kind, id) {
      store.delete(k(kind, id));
    },
  };
  return { keyring, store };
}

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

describe('createKeyProvider', () => {
  it('mints one stable key per principal and forgets it on destroy', async () => {
    const { keyring } = makeKeyring();
    const keys = createKeyProvider(keyring, undefined);
    const a = await keys.getOrCreateDek(user, 'u1');
    const b = await keys.getOrCreateDek(user, 'u1');
    expect(a.equals(b)).toBe(true); // stable
    expect((await keys.getDek(user))?.equals(a)).toBe(true);
    await keys.destroyDek(user);
    expect(await keys.getDek(user)).toBeNull();
  });

  it('envelope-wraps the DEK at rest when a master key is set, and still recovers it', async () => {
    const { keyring, store } = makeKeyring();
    const master = createHash('sha256').update('master-secret').digest();
    const keys = createKeyProvider(keyring, master);
    const dek = await keys.getOrCreateDek(user, 'u1');
    // Stored value is wrapped, not the raw key.
    expect(store.get('user:u1')?.startsWith('enc:')).toBe(true);
    expect((await keys.getDek(user))?.equals(dek)).toBe(true);
  });

  it('encrypts a fact end-to-end through the provider key', async () => {
    const { keyring } = makeKeyring();
    const keys = createKeyProvider(keyring, undefined);
    const dek = await keys.getOrCreateDek(user, 'u1');
    const sealed = encryptFact(dek, 'discovery calls');
    const fetched = await keys.getDek(user);
    expect(fetched && decryptFact(fetched, sealed)).toBe('discovery calls');
  });
});
