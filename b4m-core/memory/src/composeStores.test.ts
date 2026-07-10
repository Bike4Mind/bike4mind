import { describe, it, expect } from 'vitest';
import { firstMatchStore } from './composeStores';
import type { MemoryStore } from './store';
import type { MemoryProfile } from './types';

const prof = (id: string): MemoryProfile => ({ principal: { kind: 'agent', id }, beliefs: [] });

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
