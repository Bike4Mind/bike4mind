import { describe, it, expect } from 'vitest';
import { createPersonaAgentMemoryStore, type PersonaAgentReader } from './personaAgentMemoryStore';

const agent = () => ({
  _id: 'ag1',
  name: 'Nova',
  description: 'romantic partner',
  memoryJournal: [
    {
      id: 'j1',
      content: 'Erik likes dry humor.',
      importance: 5,
      source: 'conversation',
      timestamp: new Date('2026-07-10T00:00:00Z'),
    },
  ],
});

// Fake repo that enforces ownership the way findByIdAndUserId does: only returns the agent when
// the requested userId owns it (owner is 'u1' here).
const reader = (owned: boolean): PersonaAgentReader => ({
  findByIdAndUserId: async (id, userId) => (owned && id === 'ag1' && userId === 'u1' ? agent() : null),
});

describe('createPersonaAgentMemoryStore', () => {
  it('returns the folded profile for an agent owned by the requester', async () => {
    const store = createPersonaAgentMemoryStore({ agents: reader(true), ownerUserId: 'u1' });
    const p = await store.readProfile({ kind: 'agent', id: 'ag1' });
    expect(p?.name).toBe('Nova');
    expect(p?.beliefs[0]).toMatchObject({
      fact: 'Erik likes dry humor.',
      evidenceTier: 'engineering-proxy',
      confidence: 1,
    });
  });

  it('returns null for a requester who does not own the agent (scope isolation)', async () => {
    const store = createPersonaAgentMemoryStore({ agents: reader(true), ownerUserId: 'someone-else' });
    expect(await store.readProfile({ kind: 'agent', id: 'ag1' })).toBeNull();
  });

  it('returns null for non-agent principals', async () => {
    const store = createPersonaAgentMemoryStore({ agents: reader(true), ownerUserId: 'u1' });
    expect(await store.readProfile({ kind: 'user', id: 'u1' })).toBeNull();
  });
});
