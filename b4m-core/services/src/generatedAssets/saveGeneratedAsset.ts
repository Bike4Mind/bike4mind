import {
  extensionFromMimeType,
  FabFileSourceType,
  GENERATED_ASSET_GENERATOR_TAG,
  GENERATED_ASSET_MAX_STORED_TEXT_CHARS,
  GENERATED_ASSET_TAG,
  isStorageLimitError,
  KnowledgeType,
  videoFileExtension,
  type GeneratedAssetGenerator,
  type GeneratedAssetMetadata,
  type GeneratedAssetSaveSkippedReason,
  type IBaseRepository,
  type IFabFileDocument,
} from '@bike4mind/common';
import { createFabFile, type CreateFabFileAdapters } from '../fabFileService/create';

type Modality = 'audio' | 'video' | 'image';

const MODALITY: Record<GeneratedAssetGenerator, Modality> = {
  music: 'audio',
  speech: 'audio',
  sound_effect: 'audio',
  video: 'video',
  image: 'image',
};

const KNOWLEDGE_TYPE: Record<Modality, KnowledgeType> = {
  audio: KnowledgeType.AUDIO,
  video: KnowledgeType.VIDEO,
  image: KnowledgeType.FILE,
};

const KEY_PREFIX: Record<Modality, string> = {
  audio: 'generated-audio',
  video: 'generated-video',
  image: 'generated',
};

const PROMPT_SNIPPET_CHARS = 40;

export type SaveGeneratedAssetResult =
  | { saved: true; fileId: string; s3Key: string; fileName: string; fileUrl?: string }
  | { saved: false; reason: GeneratedAssetSaveSkippedReason };

export type SaveGeneratedAssetParams = {
  userId: string;
  bytes: Buffer;
  /** The producer's own content type. It outranks the file name, so it must come from the provider, never a request. */
  contentType: string;
  generation: GeneratedAssetMetadata;
  /** The notebook the asset was made in, for in-chat producers. */
  sessionId?: string;
  questId?: string;
  /** Generated-bucket key of the copy the producer also keeps for inline chat playback; deletes remove it too. */
  generatedCopyKey?: string;
  /** An abort rejects rather than reporting a skipped save, so a lease-bounded step fails and retries. */
  signal?: AbortSignal;
};

export type SaveGeneratedAssetDeps = {
  db: CreateFabFileAdapters['db'] & {
    fabFiles: CreateFabFileAdapters['db']['fabFiles'] & Pick<IBaseRepository<IFabFileDocument>, 'findOne'>;
  };
  storage: CreateFabFileAdapters['storage'];
  logger: {
    info: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
};

/**
 * Keeps a generated output (music, video, speech, sound effect, image) as a FabFile in the user's files, with
 * typed provenance in `sourceMetadata.generation`. Every generator goes through here, so quota, size cap,
 * moderation and tagging are the same for all of them.
 *
 * A failed write never throws: the output was already produced and billed, so the caller still delivers it and
 * reports the returned reason. An abort and a failed job-dedup lookup do reject, so a job step retries.
 * Idempotent per `generation.jobId`: a job step that runs twice gets the first file back rather than a duplicate.
 */
export async function saveGeneratedAsset(
  params: SaveGeneratedAssetParams,
  deps: SaveGeneratedAssetDeps
): Promise<SaveGeneratedAssetResult> {
  const { userId, bytes, contentType, generation, signal } = params;
  const { logger } = deps;
  const jobTag = generation.jobId ? `job:${generation.jobId}` : undefined;

  if (jobTag) {
    const existing = await deps.db.fabFiles.findOne({
      userId,
      deletedAt: null,
      tags: { $elemMatch: { name: jobTag } },
    });
    if (existing?.filePath) return savedResult(existing, existing.filePath);
  }

  const modality = MODALITY[generation.generator];
  const extension = fileExtension(modality, contentType);
  if (!extension) {
    logger.error('[saveGeneratedAsset] unsupported content type', { generator: generation.generator, contentType });
    return { saved: false, reason: 'error' };
  }

  const fileName = buildFileName(generation, extension);
  try {
    const created = await createFabFile(
      userId,
      {
        type: KNOWLEDGE_TYPE[modality],
        fileName,
        mimeType: contentType,
        contentType,
        fileSize: bytes.length,
        content: bytes,
        prefix: KEY_PREFIX[modality],
        tags: [
          { name: GENERATED_ASSET_TAG, strength: 1 },
          { name: GENERATED_ASSET_GENERATOR_TAG[generation.generator], strength: 1 },
          ...(jobTag ? [{ name: jobTag, strength: 1 }] : []),
        ],
      },
      {
        db: deps.db,
        storage: deps.storage,
        provenance: {
          sourceType: FabFileSourceType.TOOL_GENERATED,
          sourceMetadata: {
            ...(params.sessionId && { sessionId: params.sessionId }),
            ...(params.questId && { questId: params.questId }),
            ...(params.generatedCopyKey && { generatedCopyKey: params.generatedCopyKey }),
            generation: storedGeneration(generation),
          },
        },
        // The extension map keeps media containers closed to user uploads (no .mp4), and the type here is the
        // producer's own, so the claim wins.
        mimeTypePrecedence: 'claim-first',
      }
    );
    if (!created.filePath) {
      logger.error('[saveGeneratedAsset] created file has no storage path', { fileId: created.id });
      return { saved: false, reason: 'error' };
    }
    return savedResult(created, created.filePath);
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason = skipReasonFor(error);
    if (reason === 'error') {
      logger.error('[saveGeneratedAsset] failed to save generated asset', { generator: generation.generator, error });
    } else {
      logger.info('[saveGeneratedAsset] generated asset not saved', { generator: generation.generator, reason });
    }
    return { saved: false, reason };
  }
}

function storedGeneration(generation: GeneratedAssetMetadata): GeneratedAssetMetadata {
  const prompt = generation.prompt.slice(0, GENERATED_ASSET_MAX_STORED_TEXT_CHARS);
  return {
    ...generation,
    prompt,
    promptTruncated: prompt.length < generation.prompt.length,
    ...(generation.lyrics !== undefined && {
      lyrics: generation.lyrics.slice(0, GENERATED_ASSET_MAX_STORED_TEXT_CHARS),
    }),
  };
}

function savedResult(file: IFabFileDocument, s3Key: string): SaveGeneratedAssetResult {
  return { saved: true, fileId: file.id, s3Key, fileName: file.fileName, fileUrl: file.fileUrl };
}

function fileExtension(modality: Modality, contentType: string): string | undefined {
  if (modality === 'video') return videoFileExtension(contentType) ?? undefined;
  return extensionFromMimeType(contentType);
}

function skipReasonFor(error: unknown): GeneratedAssetSaveSkippedReason {
  if (!isStorageLimitError(error)) return 'error';
  return error.info.errorCode === 'file_too_large' ? 'file_too_large' : 'storage_limit';
}

// No dots in the snippet, so the appended extension is the only one the name carries.
function buildFileName(generation: GeneratedAssetMetadata, extension: string): string {
  const label = GENERATED_ASSET_GENERATOR_TAG[generation.generator];
  const snippet = generation.prompt
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, PROMPT_SNIPPET_CHARS)
    .replace(/-+$/, '');
  const unique = generation.jobId ?? String(Date.now());
  return `${snippet ? `${label}-${snippet}` : label}-${unique}.${extension}`;
}
