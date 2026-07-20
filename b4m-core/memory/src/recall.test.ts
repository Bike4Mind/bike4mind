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
    const out = recall([pharma, quantum, hobby], 'pharma clients', { activationWeight: 0.25 });
    expect(out[0].belief.id).toBe('pharma');
    expect(out[0].relevance).toBeGreaterThan(0);
  });

  it('an empty query falls back to pure activation order (most top-of-mind first)', () => {
    const out = recall([pharma, quantum, hobby], '');
    expect(out.map(r => r.belief.id)).toEqual(['quantum', 'hobby', 'pharma']);
  });

  it('a cosine floor does NOT swallow an embedding-less belief that lexically matches', () => {
    // The bug two reviewers found: with an embedding scorer AND a cosine minRelevance, a belief with
    // no vector was scored by lexical Jaccard and then measured against the COSINE floor - which a
    // Jaccard score never clears, so the belief vanished silently. It must instead be floored on the
    // lexical scale and survive when it genuinely shares words with the query.
    const embedded = belief({ id: 'embedded', fact: 'anything', embedding: [1, 0, 0] });
    const noVector = belief({ id: 'sailing', fact: 'Enjoys sailing on weekends' }); // no embedding
    const scorer = embeddingScorer([0, 1, 0]); // query vector orthogonal to `embedded` -> cosine 0

    const out = recall([embedded, noVector], 'sailing weekends', {
      scorer,
      minRelevance: 0.25, // cosine floor that a Jaccard score can never reach
    });

    expect(out.map(r => r.belief.id)).toContain('sailing'); // survives on the lexical floor
  });

  it('the lexical floor still drops an embedding-less belief with no word overlap (no noise)', () => {
    const noVector = belief({ id: 'sailing', fact: 'Enjoys sailing on weekends' });
    const scorer = embeddingScorer([0, 1, 0]);

    const out = recall([noVector], 'quantum pharmaceutical revenue', { scorer, minRelevance: 0.25 });

    expect(out).toHaveLength(0); // Jaccard ~0, below the lexical floor -> not injected as noise
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
    const out = recall([pharma, quantum, hobby], 'anything', { scorer, activationWeight: 0.25 });
    expect(out[0].belief.id).toBe('quantum');
  });

  it('is deterministic', () => {
    const args = [[pharma, quantum, hobby], 'pharma quantum', { activationWeight: 0.25 }] as const;
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

  it('falls back to the lexical scorer for a belief carrying no embedding, flagged OFF-SCALE', () => {
    const scorer = embeddingScorer([1, 0, 0]);
    const s = scorer('sailing', noEmb);
    // A lexical hit (not a 0 from the missing vector) AND marked off-scale, so recall floors it on the
    // lexical scale, not the cosine one - the fix for the cosine-floor-swallows-Jaccard bug.
    expect(s).toEqual({ relevance: expect.any(Number), offScale: true });
    expect((s as { relevance: number }).relevance).toBeGreaterThan(0);
  });

  it('falls back to lexical for every belief when the query embedding is unavailable, off-scale', () => {
    const scorer = embeddingScorer([]);
    const s = scorer('green color', green);
    expect(s).toMatchObject({ offScale: true });
    expect((s as { relevance: number }).relevance).toBeGreaterThan(0);
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
    });
    expect(out[0].belief.id).toBe('pharma');
  });
});
