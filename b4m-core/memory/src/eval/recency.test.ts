import { describe, expect, it } from 'vitest';
import { baseLevelActivation, DEFAULT_ACTIVATION } from '../activation';
import { buildBeliefs, CONTRADICTION, CORPUS_BELIEFS } from './corpus';
import { retrieveV1, retrieveV2 } from './policies';
import fixture from './embeddings.fixture.json';

/**
 * The stale-fact eval: when a user CONTRADICTS themselves, does recall surface what they believe now,
 * or what they used to?
 *
 * This is the failure that damages trust fastest. Getting a fact wrong because memory never had it is
 * forgivable; confidently repeating something the user has explicitly retracted is not - they told
 * us, and we used it against them.
 *
 * It is also the case that earns `activationWeight` its place. Both beliefs here are about Dana's
 * favorite color, so they are all but identical on topicality: semantic similarity CANNOT separate
 * them, and V1 - which ranks on similarity alone, with no notion of time - has no mechanism that
 * could. The tiebreak has to come from ACT-R activation: one statement is 5 hours old, the other 300.
 *
 * That makes this the one axis where V2 is not merely at parity with V1 but structurally capable of
 * something V1 is not.
 */

const K = 10;
const NOW = Date.parse('2026-07-12T00:00:00.000Z');
const emb = fixture.vectors as Record<string, number[]>;

// The stale belief and its later retraction, side by side - two mementos from two conversations, which
// is how this actually shows up in the data.
const beliefs = buildBeliefs([...CORPUS_BELIEFS, CONTRADICTION], emb, NOW, (t, n) =>
  baseLevelActivation(t, n, DEFAULT_ACTIVATION)
);

const QUERY = 'What shade should I paint the trim if I want to please her?';
const QUERY_ID = 'q-color-1';
const STALE = 'color'; // "favorite color is teal" - 300h old
const CURRENT = 'color-superseding'; // "now says burnt orange, not teal" - 5h old

const SHIPPED = { k: K, activationWeight: 0.025, minRelevance: 0.3 };

describe('Mementos recall: a retracted fact must not outrank the one that replaced it', () => {
  it('V2 ranks the CURRENT belief above the stale one it supersedes', () => {
    const ranked = retrieveV2(beliefs, emb[QUERY_ID], QUERY, SHIPPED);

    expect(ranked).toContain(CURRENT);
    expect(ranked.indexOf(CURRENT)).toBeLessThan(ranked.indexOf(STALE));
  });

  it('activation is what does it - with heat switched off, V2 gets it wrong', () => {
    // The control. At activationWeight 0 the two beliefs are separated by topicality alone, and
    // topicality cannot tell "my favorite color is teal" from "my favorite color is now burnt
    // orange". This is the experiment that says the ACT-R term is load-bearing rather than decorative,
    // and it is why the shipped weight is 0.1 and not 0.
    const ranked = retrieveV2(beliefs, emb[QUERY_ID], QUERY, { ...SHIPPED, activationWeight: 0 });

    expect(ranked.indexOf(CURRENT)).toBeGreaterThan(ranked.indexOf(STALE));
  });

  it('V1 gets this WRONG - similarity alone has no notion of time', () => {
    // Not a dig at V1's tuning; it is a statement about what V1 can represent. Given the same two
    // beliefs at the same floor, V1 ranks on cosine and nothing else - and cosine puts the STALE fact
    // first (0.344 vs 0.329), because "favorite color is teal" happens to sit a hair closer to the
    // question than the sentence retracting it. That the retraction is 5 hours old and the fact it
    // overturns is 300 is information V1 simply does not carry.
    //
    // This is the one axis where V2 is not merely at parity with V1 but can do something V1 cannot.
    const ranked = retrieveV1(beliefs, emb[QUERY_ID], { topK: K, minSimilarity: 0.3 });

    expect(ranked.indexOf(STALE)).toBeLessThan(ranked.indexOf(CURRENT));
  });
});
