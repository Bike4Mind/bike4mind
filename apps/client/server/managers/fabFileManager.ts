import { accessibleBy } from '@casl/mongoose';
import { IFabFile, IFabFileDocument, Permission } from '@bike4mind/common';
import { Ability } from '@server/auth/ability';
import { BadRequestError } from '@server/utils/errors';
import { getFilesStorage } from '@server/utils/storage';
import { mongoose, FabFile } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { EmbeddingService } from '@bike4mind/fab-pipeline';

// Emergency token limits for embedding generation (same as in utils.ts)
const EMBEDDING_TOKEN_LIMITS = {
  MAX_EMBEDDING_TOKENS: 7000, // Conservative limit under 8192
  CHUNK_OVERLAP: 100, // Overlap between chunks for continuity
};

/**
 * Safely generate embeddings for text that might exceed token limits
 * This is a simplified version for FAB file processing
 */
async function generateSafeEmbedding(embeddingService: EmbeddingService, text: string): Promise<number[]> {
  const modelInfo = embeddingService.getModelInfo();
  const maxTokens = Math.min(modelInfo.contextWindow - 100, EMBEDDING_TOKEN_LIMITS.MAX_EMBEDDING_TOKENS);

  // Estimate token count (rough estimation: 1 token ≈ 3.5 characters)
  const estimatedTokens = Math.ceil(text.length / 3.5);

  // If text is within limits, generate embedding directly
  if (estimatedTokens <= maxTokens) {
    return await embeddingService.generateEmbedding(text);
  }

  // Text is too large - truncate it (for FAB chunks, this shouldn't happen normally)
  Logger.warn(`FAB file chunk exceeds embedding token limit (${estimatedTokens} > ${maxTokens}), truncating...`);

  const maxChunkLength = Math.floor(maxTokens * 3.5);
  const truncatedText = text.slice(0, maxChunkLength);

  return await embeddingService.generateEmbedding(truncatedText);
}

export const generateNewFabFile = (data: IFabFile): IFabFile => {
  // TODO: Do we need to ensure any fields are set to default values?
  return { ...data };
};

export const createFabFile = async (data: IFabFile, ability: Ability) => {
  if (!ability.can(Permission.create, FabFile)) {
    throw new BadRequestError('Unauthorized');
  }
  return FabFile.create(data);
};

/**
 * Updates a FabFile and its corresponding document in S3.
 *
 * @param fabFileId - The ID of the FabFile to update.
 * @param updatedData - The new data for the FabFile.
 * @param ability - CASL Ability for permission checks.
 * @param session - Optional MongoDB transaction session.
 * @returns The updated FabFile.
 */
export const updateFabFile = async (
  fabFileId: string,
  updatedData: Partial<IFabFileDocument>,
  fileContent: string | null,
  ability: Ability,
  session?: mongoose.ClientSession,
  bypassAbility: boolean = false
): Promise<IFabFileDocument> => {
  if (!fabFileId) throw new BadRequestError('Invalid ID');

  const filter = {
    _id: fabFileId,
    ...(bypassAbility ? {} : accessibleBy(ability, Permission.update).ofType(FabFile)),
  };

  const updatedFabFile = await FabFile.findOneAndUpdate(
    filter,
    { ...updatedData, updatedAt: new Date() },
    { new: true, session }
  ).exec();

  if (!updatedFabFile) throw new BadRequestError('FabFile not found or access denied');

  if (updatedData.filePath && updatedFabFile.filePath === updatedData.filePath) {
    const fileKey = updatedFabFile.filePath;
    const newContent = fileContent;

    await getFilesStorage().upload(newContent ?? '', fileKey, {
      ContentType: updatedFabFile.mimeType,
    });

    // Get actual file size from S3 after upload
    try {
      const metadata = await getFilesStorage().getMetadata(fileKey);
      if (metadata.size !== undefined) {
        updatedFabFile.fileSize = metadata.size;
        await updatedFabFile.save({ session });
      }
    } catch (error) {
      Logger.warn('Failed to retrieve file metadata from S3:', error);
    }
  }

  return updatedFabFile;
};

export const getFabFileById = async (
  fabFileId: string,
  ability: Ability,
  action: Permission = Permission.read
): Promise<mongoose.HydratedDocument<IFabFileDocument> | null> => {
  return FabFile.findOne({ _id: fabFileId, ...accessibleBy(ability, action).ofType(FabFile) });
};

export const getVector = async (embeddingProvider: EmbeddingService, text: string): Promise<number[]> => {
  // Use safe embedding generation to avoid exceeding the model's token limit
  const response = await generateSafeEmbedding(embeddingProvider, text);
  return response;
};
