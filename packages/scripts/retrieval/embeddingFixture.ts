/**
 * The capture fixture: what Phase A writes and Phase B reads.
 *
 * This file is the seam that lets the model comparison be verified without credentials. Embedding a
 * real lake needs a provider key and a live Mongo; scoring the result needs neither. So the capture
 * writes a fixture and every downstream number is derived from it offline - which also means a run
 * can be re-analysed at a new width, or re-scored after a metrics fix, without paying to embed
 * anything twice.
 *
 * WIDTH IS PART OF THE IDENTITY. `text-embedding-3-*` are Matryoshka models, so a fixture captured
 * at full width yields every narrower arm for free (see `deriveArm`). That makes it dangerously easy
 * to compare a 1536-wide vector against a 512-wide one - both honestly labelled
 * `text-embedding-3-small` - and score noise. The shipped corpus has hit that exact bug twice (see
 * the MEMENTO_EMBEDDING_ID docblock), and here it would be worse than a silent outage: it would
 * produce a plausible table that is wrong. So the loader validates every vector's width against the
 * fixture's declared `dims` and throws, rather than trusting the label.
 */

import { z } from 'zod';
import { isSupportedEmbeddingModel, OpenAIEmbeddingModel } from '@bike4mind/common';
import { truncateAndNormalize } from '../help/utils';
import type { ScorableChunk } from './scoreDistribution';

/** A captured chunk vector plus the file it came from - the retrieval unit metrics.ts scores. */
const CapturedChunkSchema = z.object({
  chunkId: z.string().min(1),
  /** The parent document: a help slug for the `system-help` corpus, a FabFile id for a real lake. */
  docId: z.string().min(1),
  vector: z.array(z.number()),
  /** Code points of the chunk text, kept so the corpus-regime gate can be re-checked from the fixture. */
  charLength: z.number().int().nonnegative(),
});

const CapturedQuerySchema = z.object({
  /** A `PROBE_QUESTIONS` id, so the fixture joins to the committed ground truth by id alone. */
  id: z.string().min(1),
  vector: z.array(z.number()),
});

export const EmbeddingFixtureSchema = z.object({
  model: z.string().min(1),
  /** Full capture width. Every arm derived from this fixture is at most this wide. */
  dims: z.number().int().positive(),
  /** Which corpus this came from, so two fixtures cannot be compared across different lakes. */
  corpus: z.string().min(1),
  capturedAt: z.string().min(1),
  filesInScope: z.number().int().nonnegative(),
  /**
   * Chunks the capture refused to include, by the shipped `ChunkSkipReason` vocabulary. Recorded
   * here rather than only logged, so the analysis can report what an arm never saw.
   */
  chunksExcluded: z.number().int().nonnegative(),
  filesExcluded: z.number().int().nonnegative(),
  /**
   * Files the served retrieval path could not have reached - archived, soft-deleted, not fully
   * vectorized, or retrieval-excluded. See `isCapturableFile`. Recorded so an arm reports the number
   * instead of the `n/a` that would claim the harness cannot observe the class at all.
   */
  filesUnreachable: z.number().int().nonnegative(),
  chunks: z.array(CapturedChunkSchema),
  queries: z.array(CapturedQuerySchema),
});

export type EmbeddingFixture = z.infer<typeof EmbeddingFixtureSchema>;
export type CapturedChunk = z.infer<typeof CapturedChunkSchema>;

/**
 * Parse and validate a capture. Throws on a width that contradicts the declared `dims`, on either
 * side of the comparison.
 *
 * A width mismatch does NOT throw downstream - `computeCosineSimilarity` returns 0 for it, which a
 * ranking then discards as an ordinary low score. That is the failure this check exists to convert
 * into a loud one: a fixture with a few off-width vectors would otherwise render a complete,
 * confident, wrong table.
 */
export function loadEmbeddingFixture(raw: unknown): EmbeddingFixture {
  const fixture = EmbeddingFixtureSchema.parse(raw);
  const wrong = [
    ...fixture.chunks.filter(c => c.vector.length !== fixture.dims).map(c => `chunk ${c.chunkId}:${c.vector.length}`),
    ...fixture.queries.filter(q => q.vector.length !== fixture.dims).map(q => `query ${q.id}:${q.vector.length}`),
  ];
  if (wrong.length > 0) {
    throw new Error(
      `Fixture "${fixture.corpus}" declares ${fixture.model} at ${fixture.dims} dims but carries ` +
        `${wrong.length} vector(s) of another width (${wrong.slice(0, 5).join(', ')}). Cosine across ` +
        'two widths is not less precise, it is undefined - it scores 0 and disappears into the ' +
        'ranking as an ordinary low score. Re-capture rather than trusting this file.'
    );
  }
  return fixture;
}

/**
 * One `model@width` arm derived from a full-width fixture.
 *
 * `arm` is `model@dims`, never the model alone - the vector space is the model AND the width, and
 * naming an arm by its model would let two different spaces share a row label.
 */
export type DerivedArm = {
  arm: string;
  chunks: ScorableChunk[];
  queries: { id: string; vector: number[] }[];
  filesInScope: number;
  chunksExcluded: number;
  filesExcluded: number;
  filesUnreachable: number;
};

/**
 * Models whose vectors survive prefix truncation, so that a narrower arm is a real embedding rather
 * than the first N coordinates of one.
 *
 * Matryoshka is a property of a specific model, not of embeddings (see the MEMENTO_EMBEDDING_DIMS
 * docblock and b4m-core/memory/src/eval/dimensions.test.ts). `text-embedding-ada-002` predates MRL,
 * as do the Voyage, Bedrock and Ollama embedders - a truncated ada-002 vector is not an embedding of
 * anything, and rendering it as a width arm next to a legitimate `3-small@512` row puts a number in
 * the decision table that measures nothing.
 */
const MATRYOSHKA_MODELS = new Set<string>([
  OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL,
  OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE,
]);

/**
 * May a narrower arm be derived from a capture of this model?
 *
 * A model the shipped registry does not know is allowed through: `capture-embeddings.ts` validates
 * every model against that registry (`parseSupportedModels`) before it spends anything, so no real
 * capture can carry an unregistered id. What reaches here with one is a synthetic test fixture, and
 * gating those would cost this harness its own end-to-end width coverage while closing no hole.
 */
export function isTruncatableModel(model: string): boolean {
  return MATRYOSHKA_MODELS.has(model) || !isSupportedEmbeddingModel(model);
}

/**
 * Truncate a fixture to `dims` and renormalize - exactly what OpenAI's `dimensions` parameter does,
 * and the same arithmetic `toMementoVector` and the memory eval's width sweep apply, so the two
 * evals produce identical vectors for the same width.
 *
 * Reuses the shipped `truncateAndNormalize` (packages/scripts/help/utils.ts) rather than carrying a
 * third copy of five lines of arithmetic. At FULL width that helper returns the input array as-is
 * rather than renormalizing, so the full-width arm aliases the fixture's own vectors - which is
 * correct here (captured vectors are already unit-norm and cosine is scale-invariant) but means the
 * arm must be treated as read-only.
 *
 * Two widths are rejected rather than rendered. Widening past the capture is not a no-op, it is a
 * request for information the capture never held; narrowing a non-Matryoshka model produces a number
 * that measures nothing (see `isTruncatableModel`).
 */
export function deriveArm(fixture: EmbeddingFixture, dims: number): DerivedArm {
  if (dims > fixture.dims) {
    throw new Error(
      `Cannot derive a ${dims}-dim arm from a ${fixture.dims}-dim capture of ${fixture.model}. ` +
        'Matryoshka truncation only goes narrower; re-capture at the wider width.'
    );
  }
  if (dims < fixture.dims && !isTruncatableModel(fixture.model)) {
    throw new Error(
      `${fixture.model} is not a Matryoshka model, so a ${dims}-dim prefix of its ${fixture.dims}-dim ` +
        'vectors is not an embedding - it is the first coordinates of one. Score it at its capture ' +
        'width only.'
    );
  }
  return {
    arm: `${fixture.model}@${dims}`,
    chunks: fixture.chunks.map(c => ({
      chunkId: c.chunkId,
      docId: c.docId,
      vector: truncateAndNormalize(c.vector, dims),
    })),
    queries: fixture.queries.map(q => ({ id: q.id, vector: truncateAndNormalize(q.vector, dims) })),
    filesInScope: fixture.filesInScope,
    chunksExcluded: fixture.chunksExcluded,
    filesExcluded: fixture.filesExcluded,
    filesUnreachable: fixture.filesUnreachable,
  };
}

/**
 * Chunk char-length distribution and chunks-per-file - the corpus-regime gate.
 *
 * This is a GATE, not a footnote. The whole reason this ticket exists is that `3-small` was chosen
 * on a corpus of short facts, and the argument for it ("the extra capacity is for long/hard
 * documents") is exactly the argument that does not transfer to the FAB corpus's ~2200-char prose
 * passages. A capture whose median chunk is far short of that is not in the regime the question is
 * about, and a model verdict read off it inherits the very bias this ticket exists to remove.
 *
 * The prod reference to compare against: 589 chunks over 49 files (~12 per file), median 2182 chars.
 */
export type CorpusRegime = {
  files: number;
  chunks: number;
  chunksPerFile: number;
  minChars: number;
  medianChars: number;
  p90Chars: number;
  maxChars: number;
};

export function corpusRegime(chunks: readonly { docId: string; charLength: number }[], files?: number): CorpusRegime {
  if (chunks.length === 0) {
    return { files: files ?? 0, chunks: 0, chunksPerFile: 0, minChars: 0, medianChars: 0, p90Chars: 0, maxChars: 0 };
  }
  const lengths = chunks.map(c => c.charLength).sort((a, b) => a - b);
  // Nearest-rank percentile: reports a value that a real chunk actually has, rather than an
  // interpolated length no passage in the corpus is.
  const at = (q: number) => lengths[Math.min(lengths.length - 1, Math.ceil(q * lengths.length) - 1)];
  const fileCount = files ?? new Set(chunks.map(c => c.docId)).size;
  return {
    files: fileCount,
    chunks: chunks.length,
    chunksPerFile: fileCount === 0 ? 0 : chunks.length / fileCount,
    minChars: lengths[0],
    medianChars: at(0.5),
    p90Chars: at(0.9),
    maxChars: lengths[lengths.length - 1],
  };
}

/** The prod corpus this comparison is about: ~12 chunks/file, median passage ~2182 chars. */
export const PROD_REGIME_REFERENCE = { chunksPerFile: 12, medianChars: 2182 };

/**
 * Is this capture in the long-document regime the model question is actually about?
 *
 * Half the prod median is the line. It is a deliberately loose bound - the point is to catch a
 * corpus of short facts or one-line rows masquerading as the FAB corpus, not to insist a second
 * lake match prod to the character.
 */
export function isLongDocumentRegime(regime: CorpusRegime): boolean {
  return regime.medianChars >= PROD_REGIME_REFERENCE.medianChars / 2;
}

export function formatCorpusRegime(regime: CorpusRegime): string {
  return [
    `files                : ${regime.files}`,
    `chunks               : ${regime.chunks} (${regime.chunksPerFile.toFixed(1)} per file)`,
    `chunk chars          : min ${regime.minChars}, median ${regime.medianChars}, p90 ${regime.p90Chars}, max ${regime.maxChars}`,
    `prod reference       : ~${PROD_REGIME_REFERENCE.chunksPerFile} per file, median ${PROD_REGIME_REFERENCE.medianChars} chars`,
    `long-document regime : ${isLongDocumentRegime(regime) ? 'yes' : 'NO - a model verdict from this corpus does not answer the question'}`,
  ].join('\n');
}
