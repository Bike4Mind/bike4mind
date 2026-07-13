import { describe, expect, it } from 'vitest';
import { baseLevelActivation, DEFAULT_ACTIVATION } from '../activation';
import { buildBeliefs, CORPUS_BELIEFS, CORPUS_QUERIES } from './corpus';
import { aggregate, scoreNegatives, scoreQuery } from './metrics';
import { retrieveV2 } from './policies';
import fixture from './embeddings.fixture.json';

/**
 * The tuning sweep: how V2's two free parameters were chosen, kept runnable so the next person can
 * re-derive them instead of trusting a magic number.
 *
 * RUN THIS WHENEVER THE EMBEDDING MODEL CHANGES. `minRelevance` is a raw cosine, and the cosine scale
 * is a property of the model, not of the memory system - `text-embedding-ada-002` is famously
 * compressed (unrelated text still scores ~0.72), so its usable band is roughly 0.72-0.81 and the
 * floor that works there is meaningless in another vector space. Regenerate the fixture against the
 * new model, run this, and put the winning floor in MIN_RELEVANCE_BY_MODEL
 * (apps/client/server/memory/recallMementosV2.ts).
 *
 * What the surface says at the time of writing (ada-002, k=10). Reading down the floor column, the
 * two parameters trade against completely different failure modes:
 *
 *   - floor 0    : hit 100%, MRR 0.953, precision 10% | negatives: 10.0 beliefs injected, always.
 *                  Every question drags the user's ENTIRE memory into the prompt.
 *   - floor 0.76 : hit 100%, MRR 0.953, precision 45% | negatives: 1.7 injected, 86% of the time.
 *                  <- SHIPPED. The highest floor that still loses no relevant belief.
 *   - floor 0.78 : hit  94%, MRR 0.938, precision 81% | negatives: 0.3 injected, 29% of the time.
 *                  Tempting, and rejected: it buys a much quieter prompt by silently forgetting a
 *                  fact the user actually told us. A miss is the one failure the user cannot route
 *                  around - they said the thing, and we act like they never did.
 *   - floor 0.80+: hit drops to 81%. Not a memory system any more.
 *
 * And activationWeight, at the shipped floor: MRR is flat at 0.953 up to w=0.10 and drops to 0.919
 * at w=0.15. That is the line between heat breaking genuine near-ties (what ACT-R is for) and heat
 * overriding topicality (what the normalization bug used to do at full strength). 0.10 sits on it.
 */

const K = 10;
const NOW = Date.parse('2026-07-12T00:00:00.000Z');
const emb = fixture.vectors as Record<string, number[]>;

const beliefs = buildBeliefs(CORPUS_BELIEFS, emb, NOW, (t, n) =>
  baseLevelActivation(t, n, DEFAULT_ACTIVATION)
);
const positives = CORPUS_QUERIES.filter(q => q.relevant.length > 0);
const negatives = CORPUS_QUERIES.filter(q => q.relevant.length === 0);

const FLOORS = [0, 0.74, 0.76, 0.775, 0.78, 0.785, 0.79, 0.8];
const WEIGHTS = [0, 0.05, 0.1, 0.15, 0.25];

const at = (minRelevance: number, activationWeight: number) => {
  const opts = { k: K, activationWeight, minRelevance };
  return {
    pos: aggregate(
      positives.map(q =>
        scoreQuery(retrieveV2(beliefs, emb[q.id], q.query, opts), new Set(q.relevant), K)
      )
    ),
    neg: scoreNegatives(negatives.map(q => retrieveV2(beliefs, emb[q.id], q.query, opts).length)),
  };
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const rows = FLOORS.flatMap(floor => WEIGHTS.map(w => ({ floor, w, ...at(floor, w) })));

console.info(`
=== V2 parameter sweep (model=${fixture.model}, k=${K}) ===
                      POSITIVES                 NEGATIVES
floor   weight   hit@${K}    MRR   precision |  injected  false-inject`);
for (const r of rows) {
  console.info(
    `${r.floor.toFixed(3)}   ${r.w.toFixed(2)}    ${pct(r.pos.hitRate).padStart(5)}  ${r.pos.mrr.toFixed(3)}  ${pct(
      r.pos.precision
    ).padStart(8)}  |  ${r.neg.meanInjected.toFixed(1).padStart(6)}  ${pct(r.neg.falseInjectionRate).padStart(11)}`
  );
}

describe('V2 parameter tuning', () => {
  it('the shipped floor is the strictest one that still forgets nothing', () => {
    // The rule that picked 0.76, encoded so a future tweak has to argue with it: raising the floor
    // buys precision with a user's memory, and that trade is not ours to make silently.
    const SHIPPED_FLOOR = 0.76;
    const lossless = FLOORS.filter(f => at(f, 0.1).pos.hitRate === 1);

    expect(lossless).toContain(SHIPPED_FLOOR);
    expect(Math.max(...lossless)).toBe(SHIPPED_FLOOR);
  });

  it('the shipped weight is the largest at which heat only breaks ties, never overrides topic', () => {
    const SHIPPED_WEIGHT = 0.1;
    const bestMrr = at(0.76, 0).pos.mrr; // pure topicality: the ceiling activation must not damage
    const harmless = WEIGHTS.filter(w => at(0.76, w).pos.mrr >= bestMrr);

    expect(harmless).toContain(SHIPPED_WEIGHT);
    expect(Math.max(...harmless)).toBe(SHIPPED_WEIGHT);
  });

  it('the floor is what silences memory on an unanswerable question', () => {
    // Without it, EVERY off-topic question is answered with the user's entire memory in context.
    expect(at(0, 0.1).neg.meanInjected).toBe(10);
    expect(at(0.76, 0.1).neg.meanInjected).toBeLessThan(2);
  });
});
