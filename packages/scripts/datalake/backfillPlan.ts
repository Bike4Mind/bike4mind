import { modelsWithDimensions } from '@bike4mind/fab-pipeline';

export interface MissingEmbeddingChunk {
  id: string;
  fabFileId: string;
  vectorLength: number;
}

export interface FileBackfillPlan {
  fabFileId: string;
  embeddingModel: string;
  chunkCount: number;
}

/**
 * Groups chunks missing `embeddingModel` by file and resolves which model to stamp each file
 * with: the file's own `FabFile.embeddingModel` when known, else a guess from the vector width
 * of that file's own missing chunks (a legacy file that predates the field existing at all).
 * A file whose model can't be determined is returned as `unresolved` rather than guessed at -
 * stamping the wrong model would make that file's chunks silently invisible to a
 * model-scoped $vectorSearch query forever.
 *
 * `tiebreakModel` is the operator's explicit answer to "which model do same-width legacy chunks
 * belong to" - see `resolveMajorityEmbeddingModel` for why this can no longer be inferred from
 * the environment.
 */
export const planFileBackfills = (
  chunks: MissingEmbeddingChunk[],
  // Nullable, not just optional: stampChunkEmbeddingModel clears a FILE label whose chunks span
  // two embedding spaces, and `??` below already falls through to the width guess for that file.
  fileEmbeddingModels: Map<string, string | null | undefined>,
  tiebreakModel: string
): { plans: FileBackfillPlan[]; unresolved: string[] } => {
  const byFile = new Map<string, MissingEmbeddingChunk[]>();
  for (const chunk of chunks) {
    const bucket = byFile.get(chunk.fabFileId);
    if (bucket) {
      bucket.push(chunk);
    } else {
      byFile.set(chunk.fabFileId, [chunk]);
    }
  }

  const plans: FileBackfillPlan[] = [];
  const unresolved: string[] = [];

  for (const [fabFileId, fileChunks] of byFile) {
    const model =
      fileEmbeddingModels.get(fabFileId) ??
      resolveMajorityEmbeddingModel(
        fileChunks.map(c => c.vectorLength),
        tiebreakModel
      );
    if (!model) {
      unresolved.push(fabFileId);
      continue;
    }
    plans.push({ fabFileId, embeddingModel: model, chunkCount: fileChunks.length });
  }

  return { plans, unresolved };
};

/**
 * Guesses a legacy file's embedding model from the width its chunk vectors actually are, for
 * files with no `FabFile.embeddingModel` at all. Requires a clear (>50%) majority width - a
 * mixed-width sample means the file was re-embedded under more than one model and guessing
 * would silently mislabel some chunks. Ties between same-width models resolve to `tiebreakModel`,
 * which must name one of the candidates for that width.
 *
 * `tiebreakModel` is a REQUIRED caller-supplied argument, not `defaultEmbeddingModelForEnv()`.
 * ada-002 and 3-small share width 1536, so the two-candidate arm fires on every legacy 1536-wide
 * file; deriving the tiebreak from the environment default meant a post-migration deploy of this
 * script would silently relabel legacy ada-002 chunks as 3-small. This script runs standalone
 * against a point-in-time snapshot of legacy data, so the caller must say out loud which model
 * that snapshot's ties belong to.
 *
 * Enforced at runtime, not just in the type signature: an empty `tiebreakModel` reaching the
 * ambiguous-width branch throws, and so does one that names a real model that is simply the
 * wrong one for this width - neither falls through to a guess. A single-candidate width needs
 * no tiebreak and does not check it.
 */
export const resolveMajorityEmbeddingModel = (vectorLengths: number[], tiebreakModel: string): string | null => {
  const nonEmpty = vectorLengths.filter(len => len > 0);
  if (nonEmpty.length === 0) return null;

  const counts = new Map<number, number>();
  for (const len of nonEmpty) counts.set(len, (counts.get(len) ?? 0) + 1);

  let majorityWidth: number | null = null;
  let majorityCount = 0;
  for (const [width, count] of counts) {
    if (count > majorityCount) {
      majorityWidth = width;
      majorityCount = count;
    }
  }
  if (majorityWidth === null || majorityCount / nonEmpty.length <= 0.5) return null;

  const candidates = modelsWithDimensions(majorityWidth);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (!tiebreakModel) {
    throw new Error(
      `resolveMajorityEmbeddingModel: width ${majorityWidth} is ambiguous between [${candidates.join(', ')}] ` +
        'and requires an explicit tiebreakModel - it is not inferred from the deployment default.'
    );
  }
  if (!candidates.includes(tiebreakModel)) {
    // A --model that names a real embedding model but the WRONG one for this width (e.g.
    // text-embedding-3-large against 1536-wide legacy vectors) must not fall through to a guess -
    // that silently mislabels files exactly the way an unset tiebreak used to, and it is not
    // self-healing: findChunksMissingEmbeddingModel only returns still-unlabeled chunks, so a
    // corrective rerun would skip the damaged files entirely.
    throw new Error(
      `resolveMajorityEmbeddingModel: tiebreakModel "${tiebreakModel}" is not a candidate for width ` +
        `${majorityWidth} (expected one of [${candidates.join(', ')}]).`
    );
  }
  return tiebreakModel;
};
