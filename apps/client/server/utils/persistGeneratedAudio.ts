import { Logger } from '@bike4mind/observability';
import { KnowledgeType, extensionFromMimeType } from '@bike4mind/common';
import { FabFile, User, adminSettingsRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';

export type GeneratedAudioSource = 'tts' | 'sound-effect' | 'music';

/** Human-friendly file-name prefix for each generated-audio source. */
const FILE_NAME_LABELS: Record<GeneratedAudioSource, string> = {
  tts: 'speech',
  'sound-effect': 'sound-effect',
  music: 'music',
};

/**
 * Outcome of trying to persist generated audio. `saved: false` is never fatal:
 * the audio was already produced (and the caller already billed for it), so the
 * bytes must still be returned to the caller - this only reports whether a
 * browsable copy was kept.
 */
export type PersistGeneratedAudioResult =
  | { saved: true; fabFileId: string; fileName: string; fileUrl?: string }
  | { saved: false; reason: 'storage_limit' | 'file_too_large' | 'error' };

/**
 * Persist generated audio (TTS, sound-effect, or music) as a browsable `AUDIO`
 * FabFile. `source` only varies the file-name prefix and the `generated` tag;
 * every source takes the identical storage path.
 *
 * Routes through `fabFilesService.createFabFile`, which enforces the per-user
 * storage quota (`checkStorageLimitForFile`) and the `MaxFileSize` admin
 * setting, and whose S3 write is counted toward the user's storage total by the
 * async `objectCreated` handler - so this helper carries no quota logic of its
 * own. Audio is stored with `type: AUDIO`; it is deliberately never chunked,
 * vectorized, or attachable to a chat completion (see the `audio/*` guards in
 * `processFileInParallel` and `objectCreated`).
 */
export async function persistGeneratedAudio(params: {
  userId: string;
  audio: Buffer;
  contentType: string;
  source: GeneratedAudioSource;
  /** Original prompt text, used only to build a friendly file name. */
  text?: string;
  /** Fallback extension when the content type is unmapped. */
  format?: string;
  logger: Logger;
}): Promise<PersistGeneratedAudioResult> {
  const { userId, audio, contentType, source, text, format, logger } = params;

  const ext = extensionFromMimeType(contentType) || format || 'mp3';
  const label = FILE_NAME_LABELS[source];
  // Short, sanitized snippet of the prompt (no dots, so the appended extension
  // is the only one getFileExtension can pick up).
  const snippet = text
    ?.trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');
  const fileName = `${snippet ? `${label}-${snippet}` : label}-${Date.now()}.${ext}`;

  try {
    const result = await fabFilesService.createFabFile(
      userId,
      {
        type: KnowledgeType.AUDIO,
        fileName,
        mimeType: contentType,
        contentType,
        fileSize: audio.length,
        content: audio,
        prefix: 'generated-audio',
        tags: [
          { name: 'generated', strength: 1 },
          { name: source, strength: 1 },
        ],
      },
      {
        db: {
          adminSettings: adminSettingsRepository,
          fabFiles: FabFile,
          users: User,
        },
        storage: {
          upload: (path, content, options) =>
            getFilesStorage().upload(content, path, { ContentType: options?.ContentType || contentType }),
          generateSignedUrl: (path, expireInSeconds, type) =>
            getFilesStorage().getSignedUrl(path, type ?? 'get', { expiresIn: expireInSeconds }),
        },
      }
    );

    return { saved: true, fabFileId: result.id, fileName, fileUrl: result.fileUrl };
  } catch (error) {
    // createFabFile throws BadRequestError for both the storage quota ("storage
    // limit") and the per-file cap ("maximum file size"). Map to a
    // caller-actionable reason and never rethrow - the audio must still be sent.
    const message = error instanceof Error ? error.message : '';
    const reason = /storage limit/i.test(message)
      ? 'storage_limit'
      : /maximum file size/i.test(message)
        ? 'file_too_large'
        : 'error';
    if (reason === 'error') {
      logger.error('[persistGeneratedAudio] failed to persist generated audio (non-fatal)', { error });
    } else {
      logger.info('[persistGeneratedAudio] generated audio not saved', { reason });
    }
    return { saved: false, reason };
  }
}
