import { describe, it, expect } from 'vitest';
import { personaAgentToProfile, type PersonaAgentLike } from './personaAgent';

describe('personaAgentToProfile', () => {
  it('folds an AgentModel memoryJournal into a MemoryProfile (lossy, lowest tier)', () => {
    const agent: PersonaAgentLike = {
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
          relatedEntityIds: ['e9'],
        },
        {
          id: 'j2',
          content: 'Prefers dark mode.',
          importance: 2,
          source: 'heartbeat',
          timestamp: '2026-07-10T01:00:00.000Z',
        },
      ],
    };
    const p = personaAgentToProfile(agent);
    expect(p.principal).toEqual({ kind: 'agent', id: 'ag1' });
    expect(p.name).toBe('Nova');
    expect(p.role).toBe('romantic partner');
    expect(p.sizeBudgetBytes).toBeUndefined();
    expect(p.beliefs[0]).toEqual({
      id: 'j1',
      fact: 'Erik likes dry humor.',
      evidenceTier: 'engineering-proxy',
      confidence: 1,
      derivedFrom: ['e9'],
      lastAffirmedAt: '2026-07-10T00:00:00.000Z',
    });
    // importance 2/5 -> 0.4; no relatedEntityIds -> derivedFrom falls back to [source]
    expect(p.beliefs[1]).toMatchObject({
      confidence: 0.4,
      derivedFrom: ['heartbeat'],
      lastAffirmedAt: '2026-07-10T01:00:00.000Z',
    });
  });

  it('prefers id over _id and tolerates an absent journal', () => {
    const p = personaAgentToProfile({ id: 'a', _id: 'b', name: 'X' });
    expect(p.principal.id).toBe('a');
    expect(p.beliefs).toEqual([]);
  });
});
