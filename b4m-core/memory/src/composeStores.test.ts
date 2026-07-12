import { describe, it, expect } from 'vitest';
import { firstMatchStore, mergeStores } from './composeStores';
import type { MemoryStore } from './store';
import type { Belief, MemoryProfile } from './types';

const prof = (id: string): MemoryProfile => ({ principal: { kind: 'agent', id }, beliefs: [] });

const belief = (id: string, activation: number): Belief => ({
  id,
  fact: id,
  evidenceTier: 'engineering-proxy',
  confidence: 0.4,
  activation,
  derivedFrom: [],
  lastAffirmedAt: '2026-07-01T00:00:00.000Z',
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
  it('unions beliefs across stores (ledger + V1 mementos), most active first', async () => {
    const ledger = fixedStore(profWith('u1', [belief('subject-a', 0.5)]));
    const mementos = fixedStore(profWith('u1', [belief('memento-1', 0.9), belief('memento-2', 0.1)]));
    const merged = await mergeStores([ledger, mementos]).readProfile({ kind: 'user', id: 'u1' });
    expect(merged?.beliefs.map(b => b.id)).toEqual(['memento-1', 'subject-a', 'memento-2']);
  });

  it('de-duplicates by id, earlier store winning', async () => {
    const ledger = fixedStore(profWith('u1', [{ ...belief('shared', 0.5), fact: 'from-ledger' }]));
    const mementos = fixedStore(profWith('u1', [{ ...belief('shared', 0.9), fact: 'from-memento' }]));
    const merged = await mergeStores([ledger, mementos]).readProfile({ kind: 'user', id: 'u1' });
    expect(merged?.beliefs).toHaveLength(1);
    expect(merged?.beliefs[0].fact).toBe('from-ledger');
  });

  it('returns one side when the other is null (V1-only or V2-only user)', async () => {
    const ledger = fixedStore(null);
    const mementos = fixedStore(profWith('u1', [belief('memento-1', 0.2)]));
    const merged = await mergeStores([ledger, mementos]).readProfile({ kind: 'user', id: 'u1' });
    expect(merged?.beliefs.map(b => b.id)).toEqual(['memento-1']);
  });

  it('returns null when every store returns null', async () => {
    const merged = await mergeStores([fixedStore(null), fixedStore(null)]).readProfile({ kind: 'user', id: 'u1' });
    expect(merged).toBeNull();
  });
});
