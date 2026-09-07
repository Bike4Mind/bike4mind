/**
 * Pure attribution + tallying for `supersession-probe.ts`: which GENERATION served each chunk, and
 * whether a configuration measured anything at all. Extracted from the probe so the arithmetic the
 * whole measurement rests on is testable without a live DB or an embedding key, matching the sibling
 * probe's split (`corpus.ts`, `metrics.ts`, `sweep.ts` next to `recall-probe.ts`).
 */

/** A generation this probe seeded on purpose. */
export type Generation = 'OLD' | 'NEW';

/** A seeded generation, or `UNKNOWN` for a served chunk this run did not seed. */
export type AttributedGeneration = Generation | 'UNKNOWN';

/** What seeding recorded about one FabFile, so attribution never has to re-derive it from a tag. */
export type SeededFile = {
  fabFileId: string;
  fileName: string;
  generation: Generation;
  docIndex: number;
};

export type ChunkAttribution = {
  chunkId: string;
  fabFileId: string;
  fileName: string;
  generation: AttributedGeneration;
  score: number;
};

/** The subset of a `semanticDataLakeSearch` result row that attribution needs. */
export type SearchHit = {
  chunkId: string;
  fileId: string;
  fileName: string;
  score: number;
};

/**
 * Attribute each served chunk to the generation SEEDING recorded for its `fileId` - never to a tag,
 * since a tag is not what supersession collapses on and would misreport if it ever drifted from the
 * identity key.
 */
export function attributeChunks(hits: SearchHit[], byFabFileId: Map<string, SeededFile>): ChunkAttribution[] {
  return hits.map(hit => {
    const seeded = byFabFileId.get(hit.fileId);
    return {
      chunkId: hit.chunkId,
      fabFileId: hit.fileId,
      fileName: seeded?.fileName ?? hit.fileName,
      generation: seeded?.generation ?? 'UNKNOWN',
      score: hit.score,
    };
  });
}

/**
 * Refuse to report a configuration that served a chunk this run did not seed. An `UNKNOWN` chunk
 * counts toward neither generation tally, so tolerating one lets a contaminated run summarise as
 * `0 old / 0 new` - a stronger-looking version of the very result the probe exists to demonstrate,
 * which is the direction a failure must never fall. Two ways in: a concurrent run re-seeding the
 * corpus mid-measurement, and a scope leak (the probe user's resolved lake set is not narrowed to
 * the probe lake, so any other globally-readable lake on the stage can contribute hits to a
 * `minScore: 0` search).
 */
export function assertAllAttributed(chunks: ChunkAttribution[], context: string): void {
  const unknown = chunks.filter(c => c.generation === 'UNKNOWN');
  if (unknown.length === 0) return;
  const offenders = [...new Set(unknown.map(c => `${c.fabFileId} ("${c.fileName}")`))];
  throw new Error(
    `${context} served ${unknown.length} chunk(s) from ${offenders.length} FabFile(s) this run did not seed: ` +
      `${offenders.join(', ')}. Refusing to measure: an unattributed chunk counts toward neither the OLD nor ` +
      `the NEW tally, so the summary would understate both. Either another probe run re-seeded the corpus ` +
      `mid-measurement, or the lake scope reached beyond "supersession-probe".`
  );
}

/** Chunk counts per generation. `UNKNOWN` is reported separately so it can never hide inside a total. */
export function tallyGenerations(chunks: ChunkAttribution[]): {
  oldCount: number;
  newCount: number;
  unknownCount: number;
} {
  return {
    oldCount: chunks.filter(c => c.generation === 'OLD').length,
    newCount: chunks.filter(c => c.generation === 'NEW').length,
    unknownCount: chunks.filter(c => c.generation === 'UNKNOWN').length,
  };
}
