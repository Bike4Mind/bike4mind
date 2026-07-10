import { describe, it, expect } from 'vitest';
import { userMementosToProfile, type UserMementoLike } from './userMemento';

describe('userMementosToProfile', () => {
  const mementos: UserMementoLike[] = [
    {
      _id: 'm1',
      summary: 'Erik lives in Austin.',
      tier: 'hot',
      sessionId: 's1',
      lastAccessedAt: new Date('2026-07-10T00:00:00Z'),
    },
    {
      _id: 'm2',
      summary: 'Erik is learning quantum.',
      tier: 'warm',
      questId: 'q9',
      sessionId: null,
      lastAccessedAt: '2026-07-10T01:00:00.000Z',
    },
    { _id: 'm3', summary: 'archived note', tier: 'cold', isArchived: true, lastAccessedAt: new Date() },
  ];

  it('folds a user memento set into a user-principal MemoryProfile (archived omitted)', () => {
    const p = userMementosToProfile('u1', mementos);
    expect(p.principal).toEqual({ kind: 'user', id: 'u1' });
    expect(p.beliefs).toHaveLength(2);
    expect(p.beliefs[0]).toEqual({
      id: 'm1',
      fact: 'Erik lives in Austin.',
      evidenceTier: 'engineering-proxy',
      confidence: 0.9,
      derivedFrom: ['s1'],
      lastAffirmedAt: '2026-07-10T00:00:00.000Z',
    });
    // warm -> 0.6; sessionId null so provenance falls back to questId
    expect(p.beliefs[1]).toMatchObject({ confidence: 0.6, derivedFrom: ['q9'] });
  });

  it('falls back to weight for confidence when tier is absent', () => {
    const p = userMementosToProfile('u1', [
      { _id: 'x', summary: 's', weight: 0.42, lastAccessedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(p.beliefs[0].confidence).toBe(0.42);
  });
});
