import { describe, expect, it } from 'vitest';
import type { IMemoryLedgerEvent } from '@bike4mind/database';
import type { MemoryEventInput } from '@bike4mind/memory';
import { appendMemoryEvent, createLedgerMemoryStore, type LedgerRepo } from './ledgerMemoryStore';

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
  };
  return { repo, store };
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
    const a = await appendMemoryEvent(repo, 'u1', input({ subject: 'role', fact: 'A' }));
    const b = await appendMemoryEvent(
      repo,
      'u1',
      input({ subject: 'role', kind: 'affirm', at: '2026-07-02T00:00:00.000Z' })
    );
    expect(a.prevHash).toBeNull();
    expect(b.prevHash).toBe(a.hash);
    expect(store.map(e => e.seq)).toEqual([0, 1]);
    expect(store[1].ownerUserId).toBe('u1');
  });

  it('retries onto a fresh tip when a concurrent append wins the seq', async () => {
    const { repo, store } = makeFake({ failFirst: 2 });
    const a = await appendMemoryEvent(repo, 'u1', input({ subject: 'role', fact: 'A' }));
    expect(a.hash).toBeTruthy();
    expect(store).toHaveLength(1);
  });

  it('throws when contention never clears within the retry budget', async () => {
    const { repo } = makeFake({ failFirst: 99 });
    await expect(appendMemoryEvent(repo, 'u1', input({}))).rejects.toThrow(/retry budget/);
  });
});

describe('createLedgerMemoryStore', () => {
  it('folds a persisted chain into a profile with computed salience', async () => {
    const { repo } = makeFake();
    await appendMemoryEvent(
      repo,
      'u1',
      input({
        subject: 'role',
        fact: 'Runs discovery calls',
        evidenceTier: 'external-facing',
        at: '2026-07-10T00:00:00.000Z',
      })
    );
    const store = createLedgerMemoryStore({ ledger: repo, ownerUserId: 'u1', now: '2026-07-11T00:00:00.000Z' });
    const profile = await store.readProfile({ kind: 'user', id: 'u1' });
    expect(profile?.beliefs).toHaveLength(1);
    expect(profile?.beliefs[0].fact).toBe('Runs discovery calls');
    expect(profile?.beliefs[0].evidenceTier).toBe('external-facing');
    expect(['hot', 'warm', 'cold']).toContain(profile?.beliefs[0].salience);
  });

  it('returns null for an empty chain', async () => {
    const { repo } = makeFake();
    const store = createLedgerMemoryStore({ ledger: repo, ownerUserId: 'u1' });
    expect(await store.readProfile({ kind: 'user', id: 'nobody' })).toBeNull();
  });

  it('is owner-scoped: a different owner cannot read the chain (no existence leak)', async () => {
    const { repo } = makeFake();
    await appendMemoryEvent(repo, 'u1', input({ subject: 'role', fact: 'A' }));
    const intruder = createLedgerMemoryStore({ ledger: repo, ownerUserId: 'someone-else' });
    expect(await intruder.readProfile({ kind: 'user', id: 'u1' })).toBeNull();
  });
});
