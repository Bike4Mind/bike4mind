import { describe, it, expect } from 'vitest';
import { firstMatchStore, mergeStores } from './composeStores';
import type { MemoryStore } from './store';
import type { Belief, MemoryProfile } from './types';

const prof = (id: string): MemoryProfile => ({ principal: { kind: 'agent', id }, beliefs: [] });

const belief = (id: string, fact: string, activation: number, over: Partial<Belief> = {}): Belief => ({
  id,
  fact,
  evidenceTier: 'engineering-proxy',
  confidence: 0.4,
  activation,
  derivedFrom: [],
  lastAffirmedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

const profWith = (id: string, beliefs: Belief[]): MemoryProfile => ({ principal: { kind: 'user', id }, beliefs });

const fixedStore = (profile: MemoryProfile | null): MemoryStore => ({
  readProfile: async p => (profile && profile.principal.id === p.id ? profile : null),
});

const store = (profile: MemoryProfile | null, tag: string, calls: string[]): MemoryStore => ({
  readProfile: async p => {
    calls.push(tag);
    return profile && profile.principal.id === p.id ? profile : null;
  },
});

describe('firstMatchStore', () => {
  it('returns the first non-null profile and short-circuits the rest', async () => {
    const calls: string[] = [];
    const s = firstMatchStore([store(null, 'a', calls), store(prof('x'), 'b', calls), store(prof('x'), 'c', calls)]);
    const r = await s.readProfile({ kind: 'agent', id: 'x' });
    expect(r?.principal.id).toBe('x');
    expect(calls).toEqual(['a', 'b']);
  });

  it('returns null when no store matches', async () => {
    const calls: string[] = [];
    const s = firstMatchStore([store(null, 'a', calls), store(null, 'b', calls)]);
    expect(await s.readProfile({ kind: 'agent', id: 'nope' })).toBeNull();
    expect(calls).toEqual(['a', 'b']);
  });
});

describe('mergeStores', () => {
  it('unions distinct beliefs across stores, most active first', async () => {
    const ledger = fixedStore(profWith('u1', [belief('s-a', 'user likes hiking on weekends', 0.5)]));
    const mementos = fixedStore(
      profWith('u1', [belief('m-1', 'user is a software engineer', 0.9), belief('m-2', 'user lives in Seattle', 0.1)])
    );
    const merged = await mergeStores([ledger, mementos]).readProfile({ kind: 'user', id: 'u1' });
    expect(merged?.beliefs.map(b => b.id)).toEqual(['m-1', 's-a', 'm-2']);
  });

  it('collapses the same fact from two sources (V2 ledger wins over its V1 memento twin)', async () => {
    // Different ids, same fact - exactly the ledger-belief vs memento situation.
    const ledger = fixedStore(
      profWith('u1', [belief('favorite color green user', "User's favorite color is green", 0.5)])
    );
    const mementos = fixedStore(profWith('u1', [belief('6a53281a2ad0', "User's favorite color is green", 0.9)]));
    const merged = await mergeStores([ledger, mementos]).readProfile({ kind: 'user', id: 'u1' });
    expect(merged?.beliefs).toHaveLength(1);
    expect(merged?.beliefs[0].id).toBe('favorite color green user'); // the ledger (earlier store) won
  });

  it('keeps distinct shredded ghosts separate (they share a redaction placeholder)', async () => {
    const ledger = fixedStore(
      profWith('u1', [
        belief('love sushi', '[shredded]', 0.35, { shredded: true }),
        belief('balls sucks trump', '[shredded]', 0.35, { shredded: true }),
      ])
    );
    const merged = await mergeStores([ledger]).readProfile({ kind: 'user', id: 'u1' });
    expect(merged?.beliefs).toHaveLength(2);
  });

  it('returns one side when the other is null (V1-only or V2-only user)', async () => {
    const ledger = fixedStore(null);
    const mementos = fixedStore(profWith('u1', [belief('m-1', 'user is a software engineer', 0.2)]));
    const merged = await mergeStores([ledger, mementos]).readProfile({ kind: 'user', id: 'u1' });
    expect(merged?.beliefs.map(b => b.id)).toEqual(['m-1']);
  });

  it('returns null when every store returns null', async () => {
    const merged = await mergeStores([fixedStore(null), fixedStore(null)]).readProfile({ kind: 'user', id: 'u1' });
    expect(merged).toBeNull();
  });

  it('enriches the winning belief with an embedding from its twin in a later store', async () => {
    // The ledger belief has the computed activation but no embedding; its V1 memento twin (same fact,
    // different id) has the stored embedding but no activation. The merged belief must carry BOTH, or
    // recall cannot rank it semantically. This is the V2 retrieval-parity path.
    const ledger = fixedStore(profWith('u1', [belief('lg1', 'Favorite color is green', 0.24)]));
    const mementos = fixedStore(
      profWith('u1', [belief('mem1', 'favorite color is green.', 0, { embedding: [0.1, 0.9] })])
    );

    const merged = await mergeStores([ledger, mementos]).readProfile({ kind: 'user', id: 'u1' });

    expect(merged!.beliefs).toHaveLength(1); // still de-duped to one
    expect(merged!.beliefs[0].id).toBe('lg1'); // ledger still wins identity
    expect(merged!.beliefs[0].activation).toBe(0.24); // ...keeps its activation
    expect(merged!.beliefs[0].embedding).toEqual([0.1, 0.9]); // ...and inherits the embedding
  });

  it('does not overwrite an embedding the winning belief already has', async () => {
    const ledger = fixedStore(profWith('u1', [belief('lg1', 'same fact', 0.2, { embedding: [1, 0] })]));
    const mementos = fixedStore(profWith('u1', [belief('mem1', 'same fact', 0, { embedding: [0, 1] })]));

    const merged = await mergeStores([ledger, mementos]).readProfile({ kind: 'user', id: 'u1' });

    expect(merged!.beliefs[0].embedding).toEqual([1, 0]);
  });
});
