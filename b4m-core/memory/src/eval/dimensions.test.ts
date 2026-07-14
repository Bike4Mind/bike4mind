import { describe, expect, it } from 'vitest';
import { baseLevelActivation, DEFAULT_ACTIVATION } from '../activation';
import { cosineSimilarity } from '../recall';
import { buildBeliefs, CORPUS_BELIEFS, CORPUS_QUERIES, DEDUP_DISTINCT, DEDUP_MERGE } from './corpus';
import { aggregate, scoreQuery } from './metrics';
import { retrieveV2 } from './policies';
import fixture from './embeddings.fixture.json';

/**
 * How much retrieval quality does TRUNCATING the embedding cost?
 *
 * text-embedding-3-* are Matryoshka models: the information is front-loaded, so the first N components
 * are themselves a usable embedding. Truncating to N dims is what OpenAI's `dimensions` parameter does,
 * and cosine is scale-invariant, so this can be measured offline from the full-width fixture with no
 * API calls at all.
 *
 * It matters because the vector is the DOMINANT cost in this system, in two places at once:
 *   - the ledger encrypts a vector per event, and the fold pulls one per live belief across the wire
 *     from a remote Mongo. 1536 floats is ~8KB of ciphertext each.
 *   - every memento stores one.
 * Cutting the width cuts both linearly.
 *
 * The catch, and it is the same catch as always: a truncated vector lives in a DIFFERENT SPACE. Cosine
 * between a 1536-dim vector and a 512-dim one is meaningless, and every threshold moves. So this exists
 * to answer two questions together - what does quality cost, and what would the thresholds have to be -
 * because shipping one without the other is the silent-outage bug this suite already caught twice.
 */

const K = 10;
const NOW = Date.parse('2026-07-12T00:00:00.000Z');
const full = fixture.vectors as Record<string, number[]>;

const WIDTHS = [1536, 1024, 768, 512, 384, 256, 128];

/** Truncate every vector to `d` dims - i.e. what the model would have returned at `dimensions: d`. */
const truncate = (d: number): Record<string, number[]> =>
  Object.fromEntries(Object.entries(full).map(([k, v]) => [k, v.slice(0, d)]));

const activationOf = (t: number[], n: number) => baseLevelActivation(t, n, DEFAULT_ACTIVATION);
const positives = CORPUS_QUERIES.filter(q => q.relevant.length > 0);

interface Row {
  dims: number;
  hitRate: number;
  mrr: number;
  /** The strictest floor that still retrieves every relevant belief - what we would have to ship at. */
  losslessFloor: number;
  /** Restatements must stay above distinct facts, or semantic de-dup stops being possible at all. */
  dedupBand: number;
  mergeMin: number;
  distinctMax: number;
}

const measure = (dims: number): Row => {
  const emb = truncate(dims);
  const beliefs = buildBeliefs(CORPUS_BELIEFS, emb, NOW, activationOf);

  // The floor has to be re-derived per width: the cosine scale is a property of the space.
  let losslessFloor = 0;
  for (let f = 0; f <= 0.9; f += 0.005) {
    const hit = aggregate(
      positives.map(q =>
        scoreQuery(
          retrieveV2(beliefs, emb[q.id], q.query, { k: K, activationWeight: 0.025, minRelevance: f }),
          new Set(q.relevant),
          K
        )
      )
    ).hitRate;
    if (hit === 1) losslessFloor = f;
  }

  const at = aggregate(
    positives.map(q =>
      scoreQuery(
        retrieveV2(beliefs, emb[q.id], q.query, { k: K, activationWeight: 0.025, minRelevance: losslessFloor }),
        new Set(q.relevant),
        K
      )
    )
  );

  const sim = (id: string) => cosineSimilarity(emb[`${id}__a`], emb[`${id}__b`]);
  const mergeMin = Math.min(...DEDUP_MERGE.map(p => sim(p.id)));
  const distinctMax = Math.max(...DEDUP_DISTINCT.map(p => sim(p.id)));

  return {
    dims,
    hitRate: at.hitRate,
    mrr: at.mrr,
    losslessFloor: +losslessFloor.toFixed(3),
    dedupBand: +(mergeMin - distinctMax).toFixed(4),
    mergeMin: +mergeMin.toFixed(4),
    distinctMax: +distinctMax.toFixed(4),
  };
};

const rows = WIDTHS.map(measure);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

console.info(`
=== Embedding width vs retrieval quality (${fixture.model}, Matryoshka truncation) ===
                        RETRIEVAL                    DE-DUP
 dims   bytes/vec   hit@${K}   MRR    floor   |  restate>=  distinct<=   band
${rows
  .map(
    r =>
      ` ${String(r.dims).padStart(4)}   ${String(r.dims * 4).padStart(6)}B   ${pct(r.hitRate).padStart(5)}  ${r.mrr.toFixed(
        3
      )}  ${r.losslessFloor.toFixed(3)}   |   ${r.mergeMin.toFixed(4)}    ${r.distinctMax.toFixed(4)}   ${
        r.dedupBand > 0 ? '+' : ''
      }${r.dedupBand.toFixed(4)}`
  )
  .join('\n')}

"band" is restatement-floor minus distinct-ceiling: the room a de-dup threshold has to live in.
A band <= 0 means no cosine threshold can separate a restatement from a different fact at that width.
`);

describe('embedding width', () => {
  it('retrieval quality survives truncation to 512 dims', () => {
    const at512 = rows.find(r => r.dims === 512)!;
    const at1536 = rows.find(r => r.dims === 1536)!;

    expect(at512.hitRate).toBe(at1536.hitRate);
    expect(at512.mrr).toBeGreaterThanOrEqual(at1536.mrr);
  });

  it('de-dup stays possible at 512 dims - restatements still separable from distinct facts', () => {
    // The half of this that is easy to forget. Retrieval could look fine while the write path quietly
    // lost the ability to tell "allergic to shellfish" from "allergic to peanuts".
    const at512 = rows.find(r => r.dims === 512)!;
    expect(at512.dedupBand).toBeGreaterThan(0);
  });

  it('degrades somewhere - a corpus where every width is perfect is not measuring anything', () => {
    // Guard against a flattering corpus. If 128 dims were as good as 1536, the eval would be telling us
    // nothing about width and we should not trust its verdict on 512 either.
    const worst = rows[rows.length - 1];
    const best = rows[0];
    expect(worst.dedupBand).toBeLessThan(best.dedupBand);
  });
});
