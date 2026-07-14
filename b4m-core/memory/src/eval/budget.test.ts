import { describe, expect, it } from 'vitest';
import { baseLevelActivation, DEFAULT_ACTIVATION } from '../activation';
import { buildBeliefs, CORPUS_BELIEFS, CORPUS_QUERIES } from './corpus';
import { retrieveV2 } from './policies';
import fixture from './embeddings.fixture.json';

/**
 * The COST axis of the eval, as a CI gate.
 *
 * Everything recall injects is paid for on EVERY chat turn, forever - it lands in the completion's input
 * tokens. The other eval files guard that the right fact comes back; this one guards that we do not pay
 * for a pile of wrong ones to get it. It is the deterministic, offline half of the scorecard's cost
 * axis (the live half, in USD against a real corpus, runs from memento-eval/scorecard).
 *
 * The failure this catches is a one-line regression that no accuracy test would: drop `minRelevance` a
 * little and hit-rate is untouched while mean injected facts - and the token bill - quietly doubles.
 * Recall floors and negatives OVERLAP on real data (an unanswerable question can out-score a real hit),
 * so injection is a priced trade, and this test is where the price is pinned.
 *
 * Facts and characters, not tokens: this package is a pure zero-dependency leaf and must stay one, so it
 * does not pull in a tokenizer. Characters are a stable proxy (~4 chars/token for English), and the
 * point here is a REGRESSION bound, not a billing figure - the scorecard reports the real dollars.
 */

const K = 8;
const FLOOR = 0.25;
const WEIGHT = 0.025;
const NOW = Date.parse('2026-07-12T00:00:00.000Z');
const emb = fixture.vectors as Record<string, number[]>;

const beliefs = buildBeliefs(CORPUS_BELIEFS, emb, NOW, (t, n) => baseLevelActivation(t, n, DEFAULT_ACTIVATION));
const byId = new Map(CORPUS_BELIEFS.map(b => [b.id, b.fact]));
const positives = CORPUS_QUERIES.filter(q => q.relevant.length > 0);
const negatives = CORPUS_QUERIES.filter(q => q.relevant.length === 0);

const inject = (q: (typeof CORPUS_QUERIES)[number]) =>
  retrieveV2(beliefs, emb[q.id], q.query, { k: K, activationWeight: WEIGHT, minRelevance: FLOOR });

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const posInjectedFacts = positives.map(q => inject(q).length);
const posInjectedChars = positives.map(q => inject(q).reduce((s, id) => s + (byId.get(id)?.length ?? 0), 0));
const negInjectedFacts = negatives.map(q => inject(q).length);

describe('recall cost budget (the price of the floor)', () => {
  it('injects a bounded number of facts per answerable turn', () => {
    // At the shipped floor this sits near 2.6 on the synthetic corpus (1.6 on the real one). The bound is
    // a REGRESSION tripwire, not a target: if a floor/k change pushes it here, it pushes the token bill
    // on every real turn, and that must be a deliberate decision with a number attached - re-run the
    // scorecard - not a silent side effect.
    expect(mean(posInjectedFacts)).toBeLessThanOrEqual(4);
    expect(Math.max(...posInjectedFacts)).toBeLessThanOrEqual(K); // never more than we asked for
  });

  it('keeps the per-turn memory payload small in characters', () => {
    // ~4 chars/token, so this cap is roughly a few hundred tokens of memory per turn. Crossing it means
    // the recurring completion cost moved, whatever the retrieval numbers say.
    expect(mean(posInjectedChars)).toBeLessThanOrEqual(600);
  });

  it('stays nearly silent on questions memory cannot answer', () => {
    // The negatives are adversarial - near-miss questions about the same person - so this is a worst
    // case. A regression that starts dumping memory into off-topic turns shows up here first.
    expect(mean(negInjectedFacts)).toBeLessThan(K / 2);
  });
});
