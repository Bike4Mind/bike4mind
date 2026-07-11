import { describe, expect, it } from 'vitest';
import { lexicalScorer, recall } from './recall';
import type { Belief } from './types';

const belief = (over: Partial<Belief>): Belief => ({
  id: 'b',
  fact: 'a fact',
  evidenceTier: 'engineering-proxy',
  confidence: 0.4,
  derivedFrom: [],
  lastAffirmedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

describe('lexicalScorer', () => {
  it('scores token overlap and ignores stopwords/punctuation', () => {
    const b = belief({ fact: 'User runs discovery calls with pharma prospects.' });
    expect(lexicalScorer('pharma discovery', b)).toBeGreaterThan(0);
    expect(lexicalScorer('quantum chemistry', b)).toBe(0);
  });

  it('is 0 for an empty query or empty fact', () => {
    expect(lexicalScorer('', belief({ fact: 'anything' }))).toBe(0);
    expect(lexicalScorer('anything', belief({ fact: '' }))).toBe(0);
  });
});

describe('recall', () => {
  const pharma = belief({ id: 'pharma', fact: 'Targets pharma companies as clients', activation: 0.1 });
  const quantum = belief({ id: 'quantum', fact: 'Work intersects quantum computing', activation: 0.2 });
  const hobby = belief({ id: 'hobby', fact: 'Enjoys sailing on weekends', activation: 0.15 });

  it('ranks an on-topic belief above a more-active off-topic one', () => {
    const out = recall([pharma, quantum, hobby], 'pharma clients', { relevanceWeight: 3 });
    expect(out[0].belief.id).toBe('pharma');
    expect(out[0].relevance).toBeGreaterThan(0);
  });

  it('an empty query falls back to pure activation order (most top-of-mind first)', () => {
    const out = recall([pharma, quantum, hobby], '');
    expect(out.map(r => r.belief.id)).toEqual(['quantum', 'hobby', 'pharma']);
  });

  it('limits to k results', () => {
    const out = recall([pharma, quantum, hobby], '', { k: 2 });
    expect(out).toHaveLength(2);
  });

  it('minRelevance drops off-topic beliefs however active they are', () => {
    // quantum is the most active belief but "sailing" does not match it; a relevance floor keeps
    // only the on-topic hobby, so a merely-hot belief is not injected into an unrelated context.
    const out = recall([pharma, quantum, hobby], 'sailing', { minRelevance: 0.01 });
    expect(out.map(r => r.belief.id)).toEqual(['hobby']);
  });

  it('uses an injected scorer (e.g. an embedding stand-in)', () => {
    const scorer = (_q: string, b: Belief) => (b.id === 'quantum' ? 1 : 0);
    const out = recall([pharma, quantum, hobby], 'anything', { scorer, relevanceWeight: 5 });
    expect(out[0].belief.id).toBe('quantum');
  });

  it('is deterministic', () => {
    const args = [[pharma, quantum, hobby], 'pharma quantum', { relevanceWeight: 2 }] as const;
    expect(recall(...args)).toEqual(recall(...args));
  });
});
