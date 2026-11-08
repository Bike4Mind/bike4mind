import { accessibleBy } from '@casl/mongoose';
import { IFabFile, IFabFileDocument, Permission } from '@bike4mind/common';
import { Ability } from '@server/auth/ability';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { mongoose, FabFile } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { embedOne, type BoundEmbeddingModel } from '@bike4mind/services/llm/embeddingProviders';

// Emergency token limits for embedding generation (same as in utils.ts)
const EMBEDDING_TOKEN_LIMITS = {
  MAX_EMBEDDING_TOKENS: 7000, // Conservative limit under 8192
  CHUNK_OVERLAP: 100, // Overlap between chunks for continuity
};

/** Truncates text that would exceed the model's input limit (for FAB chunks, this shouldn't happen normally). */
function truncateForEmbedding(embeddingService: BoundEmbeddingModel, text: string): string {
  const maxTokens = Math.min(embeddingService.maxInputTokens - 100, EMBEDDING_TOKEN_LIMITS.MAX_EMBEDDING_TOKENS);

  // Estimate token count (rough estimation: 1 token ~ 3.5 characters)
  const estimatedTokens = Math.ceil(text.length / 3.5);
  if (estimatedTokens <= maxTokens) return text;

  Logger.warn(`FAB file chunk exceeds embedding token limit (${estimatedTokens} > ${maxTokens}), truncating...`);
  return text.slice(0, Math.floor(maxTokens * 3.5));
}

export const generateNewFabFile = (data: IFabFile): IFabFile => {
  // TODO: Do we need to ensure any fields are set to default values?
  return { ...data };
};

// Performs no admission checks - not the admin MaxFileSize, not the storage quota. Every caller
// must gate before calling, or route through fabFileService.createFabFile which gates for you.
// Current callers of THIS function, and where each one gates:
//   pages/api/files/generate-presigned-url.ts - MaxFileSize and the quota, per file
//   pages/api/files/generate-presigned-urls-batch.ts - MaxFileSize per file, quota on the batch total
//   apps/workers/src/queueHandlers/lakeIngestShared.ts (ingestLakeFile) - its callers, driveLakeIngest.ts and
//     githubLakeSlice.ts, each gate MaxFileSize per file and the quota on a running accepted-bytes total
//
// Scoped to this function only - it says nothing about doors that skip it and call
// fabFileRepository.create (or the FabFile model) directly, such as agent avatar generation, the
// help datalake ingest, and the supersession probe. Each of those records its own admission
// reasoning at its own call site.
export const createFabFile = async (data: IFabFile, ability: Ability) => {
  if (!ability.can(Permission.create, FabFile)) {
    throw new BadRequestError('Unauthorized');
  }
  return FabFile.create(data);
};

export const getFabFileById = async (
  fabFileId: string,
  ability: Ability,
  action: Permission = Permission.read
): Promise<mongoose.HydratedDocument<IFabFileDocument> | null> => {
  return FabFile.findOne({ _id: fabFileId, ...accessibleBy(ability, action).ofType(FabFile) });
};

export const getVector = async (embeddingProvider: BoundEmbeddingModel, text: string): Promise<number[]> =>
  embedOne(embeddingProvider, truncateForEmbedding(embeddingProvider, text));

/** One provider call for many texts (providers batch and bound concurrency internally); order matches `texts`. */
export const getVectors = async (
  embeddingProvider: BoundEmbeddingModel,
  texts: readonly string[]
): Promise<number[][]> =>
  (await embeddingProvider.embed(texts.map(text => truncateForEmbedding(embeddingProvider, text)))).vectors;
