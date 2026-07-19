import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '../recall';
import { DEDUP_DISTINCT, DEDUP_MERGE, type DedupPair } from './corpus';
import fixture from './embeddings.fixture.json';

/**
 * The de-dup eval: when a fact is extracted from a conversation, is it something the user already told
 * us (coalesce it, and let the re-mention raise its activation) or something new (store it separately)?
 *
 * This is V2's own write-path decision. V1 made it with a cosine threshold of 0.88 that was calibrated
 * against text-embedding-ada-002; when mementos moved to text-embedding-3-small that number carried
 * over unexamined. It turns out to still work - and that is precisely the problem, because nothing
 * would have told us if it had not. A de-dup threshold failing quietly does not look like an outage,
 * it looks like memory being a bit wrong forever.
 *
 * The two failure modes are asymmetric:
 *   - merge too eagerly and a NEW fact overwrites a DIFFERENT one the user told us. "Allergic to
 *     shellfish" and "allergic to peanuts" are one word apart.
 *   - merge too shyly and the same fact accumulates as five near-identical beliefs, splitting its own
 *     activation and paying for itself five times in the prompt.
 */

const emb = fixture.vectors as Record<string, number[]>;
const SHIPPED = 0.89; // MEMENTO_DEDUP_SIMILARITY (@bike4mind/common) - keep in sync

const similarity = (p: DedupPair) => cosineSimilarity(emb[`${p.id}__a`], emb[`${p.id}__b`]);

const mergeScores = DEDUP_MERGE.map(similarity);
const distinctScores = DEDUP_DISTINCT.map(similarity);

const lowestRestatement = Math.min(...mergeScores);
const highestDistinct = Math.max(...distinctScores);

console.info(`
=== Memento de-dup calibration (model=${fixture.model}) ===
RESTATEMENTS (same belief, reworded -> must MERGE)
${DEDUP_MERGE.map((p, i) => `  ${mergeScores[i].toFixed(4)}  ${p.id.padEnd(12)} ${p.note ?? ''}`).join('\n')}

DISTINCT (same subject, different claim -> must NOT merge)
${DEDUP_DISTINCT.map((p, i) => `  ${distinctScores[i].toFixed(4)}  ${p.id.padEnd(14)} ${p.note ?? ''}`).join('\n')}

safe band: (${highestDistinct.toFixed(4)}, ${lowestRestatement.toFixed(4)}]   shipped: ${SHIPPED}
`);

describe('Memento de-dup threshold', () => {
  it('restatements and distinct facts are separable at all - the threshold can exist', () => {
    // If these overlapped, no cosine threshold could do this job and de-dup would need a different
    // mechanism entirely. Worth asserting rather than assuming.
    expect(lowestRestatement).toBeGreaterThan(highestDistinct);
  });

  it('the shipped threshold merges every restatement', () => {
    for (const [i, p] of DEDUP_MERGE.entries()) {
      expect(mergeScores[i], `${p.id} (${p.note}) should merge`).toBeGreaterThanOrEqual(SHIPPED);
    }
  });

  it('the shipped threshold merges NO distinct fact - the one that would corrupt memory', () => {
    // A false merge is the unrecoverable direction: the new fact overwrites the old belief's content,
    // and the thing the user actually said is gone.
    for (const [i, p] of DEDUP_DISTINCT.entries()) {
      expect(distinctScores[i], `${p.id} (${p.note}) must NOT merge`).toBeLessThan(SHIPPED);
    }
  });

  it('the shipped threshold sits near the middle of the safe band, not against a wall', () => {
    // Being merely inside the band is luck; being centred in it is a margin. The ada-era 0.88 was
    // inside this band purely by accident of the model change.
    const midpoint = (highestDistinct + lowestRestatement) / 2;
    expect(Math.abs(SHIPPED - midpoint)).toBeLessThan(0.02);
  });
});
