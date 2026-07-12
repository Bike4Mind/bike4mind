import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { IMemoryLedgerEvent } from '@bike4mind/database';
import type { MemoryEventInput, Principal } from '@bike4mind/memory';
import { appendMemoryEvent, createLedgerMemoryStore, shredPrincipalMemory, type LedgerRepo } from './ledgerMemoryStore';
import type { KeyProvider } from './factCipher';

/** In-memory fake ledger: enforces (principal, seq) uniqueness and can force N leading conflicts. */
function makeFake(opts: { failFirst?: number } = {}) {
  const store: IMemoryLedgerEvent[] = [];
  let fails = opts.failFirst ?? 0;
  const repo: LedgerRepo = {
    async head(pk, pid) {
      const chain = store.filter(e => e.principalKind === pk && e.principalId === pid).sort((a, b) => a.seq - b.seq);
      const last = chain[chain.length - 1];
      return last ? { hash: last.hash, seq: last.seq } : null;
    },
    async tryInsert(ev) {
      if (fails > 0) {
        fails--;
        return null; // simulate a concurrent append taking this seq
      }
      const clash = store.some(
        e => e.principalKind === ev.principalKind && e.principalId === ev.principalId && e.seq === ev.seq
      );
      if (clash) return null;
      const doc = { ...ev, id: `${ev.principalId}:${ev.seq}` } as IMemoryLedgerEvent;
      store.push(doc);
      return doc;
    },
    async listChain(pk, pid, owner) {
      return store
        .filter(e => e.principalKind === pk && e.principalId === pid && e.ownerUserId === owner)
        .sort((a, b) => a.seq - b.seq);
    },
    async markShredded(pk, pid, owner) {
      let n = 0;
      for (const e of store) {
        if (e.principalKind === pk && e.principalId === pid && e.ownerUserId === owner) {
          e.shredded = true;
          delete e.fact;
          delete e.factCipher;
          delete e.factIv;
          delete e.factTag;
          n += 1;
        }
      }
      return n;
    },
  };
  return { repo, store };
}

/** A key provider backed by an in-memory keyring, using the real cipher so encryption is exercised. */
function makeKeys() {
  const keys = new Map<string, Buffer>();
  const k = (p: Principal) => `${p.kind}:${p.id}`;
  const provider: KeyProvider = {
    async getOrCreateDek(p) {
      const existing = keys.get(k(p));
      if (existing) return existing;
      const dek = randomBytes(32);
      keys.set(k(p), dek);
      return dek;
    },
    async getDek(p) {
      return keys.get(k(p)) ?? null;
    },
    async destroyDek(p) {
      keys.delete(k(p));
    },
  };
  return { provider, keys };
}

const input = (over: Partial<MemoryEventInput>): MemoryEventInput => ({
  principal: { kind: 'user', id: 'u1' },
  kind: 'assert',
  subject: 's',
  at: '2026-07-01T00:00:00.000Z',
  ...over,
});

describe('appendMemoryEvent', () => {
  it('seals the genesis event with a null prevHash and chains subsequent events', async () => {
    const { repo, store } = makeFake();
    const { provider } = makeKeys();
    const a = await appendMemoryEvent(repo, provider, 'u1', input({ subject: 'role', fact: 'A' }));
    const b = await appendMemoryEvent(
      repo,
      provider,
      'u1',
      input({ subject: 'role', kind: 'affirm', at: '2026-07-02T00:00:00.000Z' })
    );
    expect(a.prevHash).toBeNull();
    expect(b.prevHash).toBe(a.hash);
    expect(store.map(e => e.seq)).toEqual([0, 1]);
    expect(store[1].ownerUserId).toBe('u1');
  });

  it('stores the fact as ciphertext and the subject as an HMAC, never plaintext', async () => {
    const { repo, store } = makeFake();
    const { provider } = makeKeys();
    await appendMemoryEvent(repo, provider, 'u1', input({ subject: 'loves sushi', fact: 'my secret fact' }));
    expect(store[0].fact).toBeUndefined();
    expect(store[0].factCipher).toBeTruthy();
    expect(store[0].subject).not.toBe('loves sushi'); // subject is HMAC'd, not the plaintext key
    expect(store[0].subject).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(store[0])).not.toContain('my secret fact');
    expect(JSON.stringify(store[0])).not.toContain('sushi');
  });

  it('HMACs the subject deterministically so re-mentions still land on one belief', async () => {
    const { repo, store } = makeFake();
    const { provider } = makeKeys();
    await appendMemoryEvent(repo, provider, 'u1', input({ subject: 'loves sushi', fact: 'A' }));
    await appendMemoryEvent(
      repo,
      provider,
      'u1',
      input({ subject: 'loves sushi', kind: 'affirm', at: '2026-07-02T00:00:00.000Z' })
    );
    expect(store[0].subject).toBe(store[1].subject); // same plaintext subject -> same HMAC
  });

  it('retries onto a fresh tip when a concurrent append wins the seq', async () => {
    const { repo, store } = makeFake({ failFirst: 2 });
    const { provider } = makeKeys();
    const a = await appendMemoryEvent(repo, provider, 'u1', input({ subject: 'role', fact: 'A' }));
    expect(a.hash).toBeTruthy();
    expect(store).toHaveLength(1);
  });

  it('throws when contention never clears within the retry budget', async () => {
    const { repo } = makeFake({ failFirst: 99 });
    const { provider } = makeKeys();
    await expect(appendMemoryEvent(repo, provider, 'u1', input({}))).rejects.toThrow(/retry budget/);
  });
});

describe('createLedgerMemoryStore', () => {
  it('decrypts persisted ciphertext and folds into a profile with computed salience', async () => {
    const { repo } = makeFake();
    const { provider } = makeKeys();
    await appendMemoryEvent(
      repo,
      provider,
      'u1',
      input({
        subject: 'role',
        fact: 'Runs discovery calls',
        evidenceTier: 'external-facing',
        at: '2026-07-10T00:00:00.000Z',
      })
    );
    const store = createLedgerMemoryStore({
      ledger: repo,
      keys: provider,
      ownerUserId: 'u1',
      now: '2026-07-11T00:00:00.000Z',
    });
    const profile = await store.readProfile({ kind: 'user', id: 'u1' });
    expect(profile?.beliefs[0].fact).toBe('Runs discovery calls');
    expect(profile?.beliefs[0].evidenceTier).toBe('external-facing');
    expect(['hot', 'warm', 'cold']).toContain(profile?.beliefs[0].salience);
  });

  it('returns null for an empty chain', async () => {
    const { repo } = makeFake();
    const { provider } = makeKeys();
    const store = createLedgerMemoryStore({ ledger: repo, keys: provider, ownerUserId: 'u1' });
    expect(await store.readProfile({ kind: 'user', id: 'nobody' })).toBeNull();
  });

  it('is owner-scoped: a different owner cannot read the chain (no existence leak)', async () => {
    const { repo } = makeFake();
    const { provider } = makeKeys();
    await appendMemoryEvent(repo, provider, 'u1', input({ subject: 'role', fact: 'A' }));
    const intruder = createLedgerMemoryStore({ ledger: repo, keys: provider, ownerUserId: 'someone-else' });
    expect(await intruder.readProfile({ kind: 'user', id: 'u1' })).toBeNull();
  });
});

describe('shredPrincipalMemory', () => {
  const principal: Principal = { kind: 'user', id: 'u1' };

  it('destroys the key so facts fold to redactions, and the belief structure survives', async () => {
    const { repo } = makeFake();
    const { provider, keys } = makeKeys();
    await appendMemoryEvent(
      repo,
      provider,
      'u1',
      input({ subject: 'role', fact: 'sensitive', at: '2026-07-10T00:00:00.000Z' })
    );

    const before = await createLedgerMemoryStore({ ledger: repo, keys: provider, ownerUserId: 'u1' }).readProfile(
      principal
    );
    expect(before?.beliefs[0].fact).toBe('sensitive');

    const count = await shredPrincipalMemory(repo, provider, principal, 'u1');
    expect(count).toBe(1);
    expect(keys.size).toBe(0); // key destroyed

    const after = await createLedgerMemoryStore({ ledger: repo, keys: provider, ownerUserId: 'u1' }).readProfile(
      principal
    );
    expect(after?.beliefs).toHaveLength(1);
    expect(after?.beliefs[0].shredded).toBe(true);
    expect(after?.beliefs[0].fact).not.toBe('sensitive');
  });
});
