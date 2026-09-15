import { describe, it, expect } from 'vitest';
import { readPrincipalMemory } from './readPrincipalMemory';
import { agentPrincipal } from './adapters/deepAgent';
import type { MemoryStore } from './store';
import type { MemoryProfile } from './types';

describe('readPrincipalMemory', () => {
  it('reads a profile for a principal through an injected store', async () => {
    const profile: MemoryProfile = {
      principal: agentPrincipal('a1'),
      name: 'Ember',
      beliefs: [],
      sizeBudgetBytes: 8192,
      version: 0,
    };
    const store: MemoryStore = { readProfile: async p => (p.id === 'a1' ? profile : null) };
    await expect(readPrincipalMemory(agentPrincipal('a1'), store)).resolves.toBe(profile);
  });

  it('returns null when the store has no profile for the principal', async () => {
    const store: MemoryStore = { readProfile: async () => null };
    await expect(readPrincipalMemory({ kind: 'user', id: 'u1' }, store)).resolves.toBeNull();
  });
});
