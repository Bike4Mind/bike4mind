import { describe, it, expect } from 'vitest';
import { charterToProfile, agentPrincipal, type DeepAgentCharterLike } from './deepAgent';
import { EVIDENCE_TIERS } from '../types';

describe('charterToProfile', () => {
  const charter: DeepAgentCharterLike = {
    identity: { agentId: 'a1', name: 'Ember', role: 'research partner' },
    semanticMemory: [
      {
        id: 'm1',
        fact: 'Erik prefers incremental delivery.',
        evidenceTier: 'human-reviewed',
        confidence: 0.9,
        sourceEpisodeIds: ['e1', 'e2'],
        lastAffirmedAt: new Date('2026-07-10T00:00:00Z'),
      },
    ],
    sizeBudgetBytes: 8192,
    version: 3,
    groomedAt: new Date('2026-07-10T01:00:00Z'),
  };

  it('maps a DeepAgent charter onto a principal-scoped MemoryProfile', () => {
    const profile = charterToProfile(charter);
    expect(profile.principal).toEqual({ kind: 'agent', id: 'a1' });
    expect(profile.name).toBe('Ember');
    expect(profile.role).toBe('research partner');
    expect(profile.sizeBudgetBytes).toBe(8192);
    expect(profile.version).toBe(3);
    expect(profile.groomedAt).toBe('2026-07-10T01:00:00.000Z');
  });

  it('carries each belief with its provenance, tier, and ISO timestamps', () => {
    const [belief] = charterToProfile(charter).beliefs;
    expect(belief).toEqual({
      id: 'm1',
      fact: 'Erik prefers incremental delivery.',
      evidenceTier: 'human-reviewed',
      confidence: 0.9,
      derivedFrom: ['e1', 'e2'],
      lastAffirmedAt: '2026-07-10T00:00:00.000Z',
    });
    expect(EVIDENCE_TIERS).toContain(belief.evidenceTier);
  });

  it('passes through ISO-string timestamps unchanged and omits an absent groomedAt', () => {
    const profile = charterToProfile({
      ...charter,
      groomedAt: undefined,
      semanticMemory: [{ ...charter.semanticMemory[0], lastAffirmedAt: '2026-07-10T00:00:00.000Z' }],
    });
    expect(profile.groomedAt).toBeUndefined();
    expect(profile.beliefs[0].lastAffirmedAt).toBe('2026-07-10T00:00:00.000Z');
  });

  it('agentPrincipal builds an agent-kind principal', () => {
    expect(agentPrincipal('x')).toEqual({ kind: 'agent', id: 'x' });
  });
});
