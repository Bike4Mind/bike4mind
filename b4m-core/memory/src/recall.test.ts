import { describe, expect, it } from 'vitest';
import { cosineSimilarity, embeddingScorer, lexicalScorer, recall } from './recall';
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

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it('is magnitude-invariant (direction is what matters)', () => {
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1);
  });

  it('returns 0 on empty, mismatched-length, or zero-magnitude vectors', () => {
    expect(cosineSimilarity([], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe('embeddingScorer', () => {
  const green = belief({ id: 'green', fact: 'favorite color is green', embedding: [1, 0, 0] });
  const pharmaEmb = belief({ id: 'pharma', fact: 'targets pharma companies', embedding: [0, 1, 0] });
  const noEmb = belief({ id: 'noEmb', fact: 'sailing on the bay' });

  it('scores a belief by cosine against the query embedding, not lexical overlap', () => {
    // The query shares NO tokens with the fact, so a lexical scorer would return 0 - this is exactly
    // the V1-parity case ("what hue do I like?" -> "favorite color is green").
    const scorer = embeddingScorer([1, 0, 0]);
    expect(scorer('what hue do I fancy', green)).toBeCloseTo(1);
    expect(lexicalScorer('what hue do I fancy', green)).toBe(0);
    expect(scorer('what hue do I fancy', pharmaEmb)).toBeCloseTo(0);
  });

  it('falls back to the lexical scorer for a belief carrying no embedding', () => {
    const scorer = embeddingScorer([1, 0, 0]);
    expect(scorer('sailing', noEmb)).toBeGreaterThan(0); // lexical hit, not a 0 from the missing vector
  });

  it('falls back to lexical for every belief when the query embedding is unavailable', () => {
    const scorer = embeddingScorer([]);
    expect(scorer('green color', green)).toBeGreaterThan(0);
  });

  it('ranks the on-topic belief over a more-active off-topic one (the V2 ranking gate)', () => {
    // The measured production bug: an off-topic belief with activation outranked the on-topic one,
    // because lexical relevance was too small to overcome the activation gap.
    const hotOffTopic = belief({
      id: 'green',
      fact: 'favorite color is green',
      embedding: [1, 0, 0],
      activation: 0.24,
    });
    const coldOnTopic = belief({ id: 'pharma', fact: 'targets pharma companies', embedding: [0, 1, 0], activation: 0 });
    const out = recall([hotOffTopic, coldOnTopic], 'which drug companies am I chasing', {
      scorer: embeddingScorer([0, 1, 0]),
      relevanceWeight: 3,
    });
    expect(out[0].belief.id).toBe('pharma');
  });
});
