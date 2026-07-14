import { describe, expect, it } from 'vitest';
import { baseLevelActivation, DEFAULT_ACTIVATION } from '../activation';
import { buildBeliefs, CORPUS_BELIEFS, CORPUS_QUERIES } from './corpus';
import { aggregate, scoreNegatives, scoreQuery } from './metrics';
import { retrieveV1, retrieveV2 } from './policies';
import fixture from './embeddings.fixture.json';

/**
 * The V1-vs-V2 retrieval head-to-head.
 *
 * The deployment model is mutually exclusive - a user is on V1 or on V2 - so V2 only earns the right
 * to retire V1 if its read path is at least as good. Before this, that claim rested on a handful of
 * hand-picked queries. Now it rests on a corpus built to be hard: every positive query shares almost
 * no vocabulary with the belief it must retrieve, and every negative is a near-miss whose answer is
 * simply not in memory.
 *
 * Deterministic and offline: the vectors are real (generated once from the production embedding
 * model, so semantic retrieval is genuinely exercised) but committed, so this runs in CI with no key
 * and no network and cannot drift.
 *
 * READ THE RESULT HONESTLY. On plain retrieval V1 and V2 come out DEAD EVEN - once both read the same
 * vector space at the same floor, both score a perfect hit rate and MRR here. V2's retrieval policy is
 * not magic, and this file exists partly to stop anyone claiming it is. What V2 adds is a dimension V1
 * has no way to represent at all: time. See recency.test.ts - when a user retracts a fact, V1 ranks on
 * similarity alone and cannot tell the retraction from the thing retracted. That, plus the ledger
 * (provenance, crypto-shred, an auditable chain), is the case for V2 - NOT a better cosine.
 *
 * The eval has already earned its keep twice, both times against MY OWN code:
 *   1. `recall` summed raw activation and raw relevance. Activation is an unbounded log quantity
 *      (spread 3.29) and cosine is not (spread 0.09), so ranking went almost entirely to heat: hit
 *      rate 69% against V1's 100%.
 *   2. The fix for (1) min-maxed BOTH axes - which destroyed the magnitude of relevance differences,
 *      turned a near-tie between a fact and its retraction into a 1.0-vs-0.0 chasm, and made the
 *      retraction unrankable at any activation weight. See recallProbability in recall.ts.
 */

const K = 10;
const NOW = Date.parse('2026-07-12T00:00:00.000Z');
const embeddings = fixture.vectors as Record<string, number[]>;

/**
 * What production actually runs. MUST stay in sync with apps/client/server/memory/recallMementosV2.ts
 * - an eval of parameters nobody ships is theatre. The floor is the one calibrated for this fixture's
 * model (ada-002); see tuning.test.ts for the sweep it comes from.
 */
const SHIPPED = { k: K, activationWeight: 0.025, minRelevance: 0.25 };

/**
 * V1 as deployed. It reads the SAME mementos from the SAME vector space, so it gets the same floor -
 * anything else would be comparing V2 against a straw man. What separates the two policies here is
 * only what they do with the scores, which is the thing worth measuring.
 */
const V1_SHIPPED = { topK: K, minSimilarity: 0.25 };

/** The floor V1 shipped with when mementos ran on ada-002. See the regression test at the bottom. */
const V1_ADA_ERA_FLOOR = 0.75;

const activationOf = (times: number[], now: number) => baseLevelActivation(times, now, DEFAULT_ACTIVATION);
const beliefs = buildBeliefs(CORPUS_BELIEFS, embeddings, NOW, activationOf);

const positives = CORPUS_QUERIES.filter(q => q.relevant.length > 0);
const negatives = CORPUS_QUERIES.filter(q => q.relevant.length === 0);

const run = (retrieve: (q: (typeof CORPUS_QUERIES)[number]) => string[]) => {
  const pos = positives.map(q => scoreQuery(retrieve(q), new Set(q.relevant), K));
  const neg = negatives.map(q => retrieve(q).length);
  return { positives: aggregate(pos), negatives: scoreNegatives(neg) };
};

const v1 = run(q => retrieveV1(beliefs, embeddings[q.id], V1_SHIPPED));
const v2 = run(q => retrieveV2(beliefs, embeddings[q.id], q.query, SHIPPED));

// Printed on every run: the eval is a REPORT first and a gate second. A number nobody reads is a
// number nobody acts on.
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.info(`
=== Mementos retrieval head-to-head (k=${K}, model=${fixture.model}) ===
corpus: ${beliefs.length} beliefs | ${positives.length} positive queries | ${negatives.length} negatives

POSITIVES (can the model SEE the fact it needs?)
              hit@${K}    recall    precision   MRR     mean injected
  V1        ${pct(v1.positives.hitRate).padStart(7)}  ${pct(v1.positives.recall).padStart(8)}  ${pct(
    v1.positives.precision
  ).padStart(9)}  ${v1.positives.mrr.toFixed(3)}  ${v1.positives.meanInjected.toFixed(1)}
  V2        ${pct(v2.positives.hitRate).padStart(7)}  ${pct(v2.positives.recall).padStart(8)}  ${pct(
    v2.positives.precision
  ).padStart(9)}  ${v2.positives.mrr.toFixed(3)}  ${v2.positives.meanInjected.toFixed(1)}

NEGATIVES (how much irrelevant memory is handed to the model to confabulate from?)
              false-injection rate    mean injected
  V1        ${pct(v1.negatives.falseInjectionRate).padStart(15)}  ${v1.negatives.meanInjected.toFixed(1).padStart(12)}
  V2        ${pct(v2.negatives.falseInjectionRate).padStart(15)}  ${v2.negatives.meanInjected.toFixed(1).padStart(12)}
`);

describe('Mementos retrieval: V1 vs V2 head-to-head', () => {
  it('V2 finds the right belief at least as often as V1 (the retirement gate)', () => {
    // The make-or-break claim of the whole deployment model, now a test rather than an assertion.
    expect(v2.positives.hitRate).toBeGreaterThanOrEqual(v1.positives.hitRate);
  });

  it('V2 ranks the right belief at least as well as V1', () => {
    expect(v2.positives.mrr).toBeGreaterThanOrEqual(v1.positives.mrr);
  });

  it('V2 surfaces the target belief for nearly every paraphrased question', () => {
    // These queries deliberately share almost no vocabulary with their belief, so a lexical policy
    // scores ~0 on them. This is the axis semantic recall exists to win.
    expect(v2.positives.hitRate).toBeGreaterThanOrEqual(0.9);
  });

  it('V2 hands the model no MORE irrelevant memory than V1 - the anti-confabulation gate', () => {
    // Everything a policy injects, the model is free to reason from. On a question memory cannot
    // answer, the safe behaviour is to stay quiet; each stray belief is an invitation to make
    // something up. V2 must not be looser here than the system it replaces.
    expect(v2.negatives.meanInjected).toBeLessThanOrEqual(v1.negatives.meanInjected);
    expect(v2.negatives.falseInjectionRate).toBeLessThanOrEqual(v1.negatives.falseInjectionRate);
  });

  it('V2 wastes no more of the prompt than V1 on the questions it CAN answer', () => {
    expect(v2.positives.precision).toBeGreaterThanOrEqual(v1.positives.precision);
  });

  it('the ada-era 0.75 floor returns NOTHING in this vector space - the outage this guards against', () => {
    // Keep this. Pinning mementos to text-embedding-3-small moved the cosine band from ~0.72-0.81 down
    // to ~0.28-0.38, and the floor is a RAW cosine: three separate call sites hardcoded ~0.75 for the
    // old band, and left alone every one of them would have rejected every memento a user has. Not an
    // error, not a crash - memory simply, silently, knows nothing.
    //
    // This is why MEMENTO_MIN_SIMILARITY lives glued to MEMENTO_EMBEDDING_MODEL in @bike4mind/common.
    // If someone moves the model and not the floor, this test is what tells them.
    const stale = run(q => retrieveV1(beliefs, embeddings[q.id], { topK: K, minSimilarity: V1_ADA_ERA_FLOOR }));

    expect(stale.positives.hitRate).toBe(0);
  });

  it('a purely lexical V2 would FAIL those same questions - proving the corpus is actually hard', () => {
    // Guard against a corpus that flatters us: if lexical overlap could answer these, the eval would
    // prove nothing about semantic retrieval. Lexical scores live on a different scale entirely, so
    // the cosine floor is dropped here - this measures the ranking, not the floor.
    const lexical = run(q =>
      retrieveV2(
        beliefs.map(b => ({ ...b, embedding: undefined })), // strip vectors -> recall falls back to lexical
        [],
        q.query,
        { k: K, activationWeight: SHIPPED.activationWeight, minRelevance: 0 }
      )
    );
    expect(lexical.positives.mrr).toBeLessThan(v2.positives.mrr);
  });
});
