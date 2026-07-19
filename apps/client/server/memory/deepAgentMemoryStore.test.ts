import { describe, it, expect } from 'vitest';
import { createDeepAgentMemoryStore, type CharterReader, type OwnedCharter } from './deepAgentMemoryStore';

const charter = (over: Partial<OwnedCharter['identity']> = {}): OwnedCharter => ({
  identity: { agentId: 'a1', ownerUserId: 'u1', name: 'Ember', role: 'research partner', ...over },
  semanticMemory: [
    {
      id: 'm1',
      fact: 'Erik prefers incremental delivery.',
      evidenceTier: 'human-reviewed',
      confidence: 0.9,
      sourceEpisodeIds: ['e1'],
      lastAffirmedAt: new Date('2026-07-10T00:00:00Z'),
    },
  ],
  sizeBudgetBytes: 8192,
  version: 2,
});

const reader = (result: OwnedCharter | null): CharterReader => ({ findByAgentId: async () => result });

describe('createDeepAgentMemoryStore', () => {
  it('returns the unified profile for an agent owned by the requester', async () => {
    const store = createDeepAgentMemoryStore({ charters: reader(charter()), ownerUserId: 'u1' });
    const profile = await store.readProfile({ kind: 'agent', id: 'a1' });
    expect(profile?.principal).toEqual({ kind: 'agent', id: 'a1' });
    expect(profile?.name).toBe('Ember');
    expect(profile?.beliefs[0]).toMatchObject({
      fact: 'Erik prefers incremental delivery.',
      evidenceTier: 'human-reviewed',
    });
  });

  it('returns null for an agent owned by someone else (scope isolation, no existence leak)', async () => {
    const store = createDeepAgentMemoryStore({
      charters: reader(charter({ ownerUserId: 'someone-else' })),
      ownerUserId: 'u1',
    });
    expect(await store.readProfile({ kind: 'agent', id: 'a1' })).toBeNull();
  });

  it('returns null when no charter exists', async () => {
    const store = createDeepAgentMemoryStore({ charters: reader(null), ownerUserId: 'u1' });
    expect(await store.readProfile({ kind: 'agent', id: 'nope' })).toBeNull();
  });

  it('returns null for non-agent principals (not yet wired)', async () => {
    const store = createDeepAgentMemoryStore({ charters: reader(charter()), ownerUserId: 'u1' });
    expect(await store.readProfile({ kind: 'user', id: 'u1' })).toBeNull();
  });
});
