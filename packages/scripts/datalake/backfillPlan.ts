import { modelsWithDimensions } from '@bike4mind/fab-pipeline';
import { defaultEmbeddingModelForEnv } from '@bike4mind/common';

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
 */
export const planFileBackfills = (
  chunks: MissingEmbeddingChunk[],
  fileEmbeddingModels: Map<string, string | undefined>
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
      fileEmbeddingModels.get(fabFileId) ?? resolveMajorityEmbeddingModel(fileChunks.map(c => c.vectorLength));
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
 * would silently mislabel some chunks. Ties between same-width models resolve to the
 * deployment's current default when it's a candidate (the overwhelmingly likely case for an
 * old file), else the first candidate alphabetically, for reproducibility.
 */
export const resolveMajorityEmbeddingModel = (vectorLengths: number[]): string | null => {
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

  const envDefault = defaultEmbeddingModelForEnv();
  return candidates.includes(envDefault) ? envDefault : candidates[0];
};
