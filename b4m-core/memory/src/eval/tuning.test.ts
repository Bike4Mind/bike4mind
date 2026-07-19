import { describe, expect, it } from 'vitest';
import { baseLevelActivation, DEFAULT_ACTIVATION } from '../activation';
import { buildBeliefs, CONTRADICTION, CORPUS_BELIEFS, CORPUS_QUERIES } from './corpus';
import { aggregate, scoreNegatives, scoreQuery } from './metrics';
import { retrieveV2 } from './policies';
import fixture from './embeddings.fixture.json';

/**
 * The tuning sweep: how V2's two free parameters were chosen, kept runnable so the next person can
 * re-derive them instead of trusting a magic number.
 *
 * RUN THIS WHENEVER THE EMBEDDING MODEL CHANGES. `minRelevance` is a raw cosine, and the cosine scale
 * is a property of the MODEL, not of the memory system. That is not a theoretical worry: mementos used
 * to run on ada-002, whose cosines are crushed into a ~0.72-0.81 band, and three call sites floored at
 * ~0.75. The same corpus under text-embedding-3-small scores 0.28-0.38, so the old floor rejects every
 * memento that exists - memory silently dark, no error. Regenerate the fixture against the new model,
 * run this, and update MEMENTO_MIN_SIMILARITY (@bike4mind/common), which is deliberately glued to
 * MEMENTO_EMBEDDING_MODEL so the two cannot drift apart.
 *
 * The two parameters answer to completely different failure modes, and each is pinned by a RULE rather
 * than a taste, so a future tweak has to argue with the rule:
 *
 *   minRelevance -> the strictest floor that still forgets NOTHING. Raising it further buys precision
 *     by silently dropping a fact the user actually told us, and that trade is not ours to make. A
 *     miss is the one failure a user cannot route around: they said the thing, and we act as if they
 *     never did.
 *
 *   activationWeight -> bounded on BOTH sides, so it is a window rather than a maximum:
 *     - too LOW and heat cannot settle a genuine tie. A fact and the user's later RETRACTION of it are
 *       equally on-topic by construction (cosine 0.366 vs 0.363), so topicality cannot separate them
 *       and recall serves the belief its owner has taken back.
 *     - too HIGH and heat stops breaking ties and starts overriding topic: merely-recent beliefs climb
 *       over the on-topic one and ranking quality falls.
 *     The shipped value sits near the middle of that window with margin either way.
 */

const K = 10;
const NOW = Date.parse('2026-07-12T00:00:00.000Z');
const emb = fixture.vectors as Record<string, number[]>;

const SHIPPED_FLOOR = 0.25;
const SHIPPED_WEIGHT = 0.025;

const activationOf = (t: number[], n: number) => baseLevelActivation(t, n, DEFAULT_ACTIVATION);
const beliefs = buildBeliefs(CORPUS_BELIEFS, emb, NOW, activationOf);
const positives = CORPUS_QUERIES.filter(q => q.relevant.length > 0);
const negatives = CORPUS_QUERIES.filter(q => q.relevant.length === 0);

const FLOORS = [0, 0.25, 0.28, 0.3, 0.32, 0.34, 0.35, 0.36, 0.4];
const WEIGHTS = [0, 0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.08, 0.4];

const at = (minRelevance: number, activationWeight: number) => {
  const opts = { k: K, activationWeight, minRelevance };
  return {
    pos: aggregate(
      positives.map(q => scoreQuery(retrieveV2(beliefs, emb[q.id], q.query, opts), new Set(q.relevant), K))
    ),
    neg: scoreNegatives(negatives.map(q => retrieveV2(beliefs, emb[q.id], q.query, opts).length)),
  };
};

/**
 * Does recall rank a user's RETRACTION above the fact it overturns? The two are indistinguishable on
 * topicality, so this isolates the activation term: it is true only when heat is strong enough to
 * settle a tie that similarity cannot.
 */
const retractionWins = (activationWeight: number): boolean => {
  const withRetraction = buildBeliefs([...CORPUS_BELIEFS, CONTRADICTION], emb, NOW, activationOf);
  const ranked = retrieveV2(
    withRetraction,
    emb['q-color-1'],
    'What shade should I paint the trim if I want to please her?',
    { k: K, activationWeight, minRelevance: SHIPPED_FLOOR }
  );
  return ranked.indexOf('color-superseding') < ranked.indexOf('color');
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

console.info(`
=== V2 parameter sweep (model=${fixture.model}, k=${K}) ===
                      POSITIVES                 NEGATIVES
floor   weight   hit@${K}    MRR   precision |  injected  false-inject  | retraction wins?`);
for (const floor of FLOORS) {
  for (const w of WEIGHTS) {
    const r = at(floor, w);
    console.info(
      `${floor.toFixed(3)}   ${w.toFixed(2)}    ${pct(r.pos.hitRate).padStart(5)}  ${r.pos.mrr.toFixed(3)}  ${pct(
        r.pos.precision
      ).padStart(
        8
      )}  |  ${r.neg.meanInjected.toFixed(1).padStart(6)}  ${pct(r.neg.falseInjectionRate).padStart(11)}  |  ${
        retractionWins(w) ? 'yes' : 'NO'
      }`
    );
  }
}

describe('V2 parameter tuning', () => {
  it('the shipped floor forgets nothing - and is deliberately BELOW the corpus optimum', () => {
    const lossless = FLOORS.filter(f => at(f, SHIPPED_WEIGHT).pos.hitRate === 1);
    expect(lossless).toContain(SHIPPED_FLOOR);

    // The corpus would happily let us go higher, and that is exactly the trap. Its facts are stated
    // crisply; real mementos are LLM summaries and they HEDGE ("User conducts discovery calls,
    // suggesting a role in sales"), which sits measurably further from a plain question. Measured on a
    // real user's memory, the best match for "what do I do for work" scores 0.2991 - a genuine memory
    // that the corpus-optimal floor would silently bin. So the shipped floor keeps margin BELOW what
    // this corpus alone would justify, and this assertion exists to stop a well-meaning future tweak
    // from "optimising" that margin away on synthetic evidence.
    expect(Math.max(...lossless)).toBeGreaterThan(SHIPPED_FLOOR);
  });

  it('the floor is what silences memory on an unanswerable question', () => {
    // Without it, EVERY off-topic question is answered with the user's entire memory in context.
    expect(at(0, SHIPPED_WEIGHT).neg.meanInjected).toBe(K);

    // This corpus's negatives are ADVERSARIAL by construction - near-miss questions about the same
    // person, chosen to sit as close to her real facts as possible - so the number here is a worst
    // case, not the expected one. Measured against a real 182-fact user corpus at the same floor, an
    // unanswerable question pulls in 0.4 stray facts on average, not 2.6.
    expect(at(SHIPPED_FLOOR, SHIPPED_WEIGHT).neg.meanInjected).toBeLessThan(K / 3);
  });

  it('the shipped weight is high enough that heat settles a tie topicality cannot', () => {
    expect(retractionWins(SHIPPED_WEIGHT)).toBe(true);

    // The lower wall is real and CLOSE: at 0.005 the retraction already loses. This is what rules out
    // "just set the weight small enough to be safe" - too small IS an unsafe end, not a cautious one.
    expect(retractionWins(0.005)).toBe(false);
  });

  it('the shipped weight is low enough that heat never overrides topic', () => {
    const bestMrr = at(SHIPPED_FLOOR, 0).pos.mrr; // pure topicality - the ceiling heat must not damage

    expect(at(SHIPPED_FLOOR, SHIPPED_WEIGHT).pos.mrr).toBeGreaterThanOrEqual(bestMrr);

    // The upper wall is close too: by 0.05 merely-recent beliefs already start climbing over the
    // on-topic one. Between this and the assertion above, the usable band is 0.01..0.04 - narrow, and
    // it MOVES when minRelevance OR the embedding width moves. Re-sweep; do not nudge.
    expect(at(SHIPPED_FLOOR, 0.05).pos.mrr).toBeLessThan(bestMrr);
  });
});
