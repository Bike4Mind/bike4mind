import type { Logger } from '@bike4mind/observability';
import type { ImageModerationService } from '@bike4mind/utils/imageModeration';
import type { ImageModerationIncident } from '@bike4mind/common';
import type { moderateUploadedFile as ModerateUploadedFile } from '@server/s3/moderateUploadedFile';

/**
 * Minimal FabFile row shape the moderation loop needs back from the atomic claim.
 */
interface ClaimedFabFile {
  _id: unknown;
  id: string;
  mimeType?: string;
}

export interface ModerateImportedKnowledgeFilesArgs {
  /** S3 keys of the just-imported knowledge files, one per FabFile. */
  filePaths: string[];
  userId: string;
  enabled: boolean;
  service: ImageModerationService;
  incidents: { record(input: ImageModerationIncident): Promise<unknown> };
  moderateImageOrThrow: Parameters<typeof ModerateUploadedFile>[0]['moderateImageOrThrow'];
  moderate: typeof ModerateUploadedFile;
  logger: Logger;
  /**
   * Atomic compare-and-swap: flip `pending`/unset -> `scanning` for the row at `filePath`, or
   * return null if another invocation already owns the scan (the natural S3 ObjectCreated event
   * for this same object can be redelivered by S3 after the import commits) or the row is already
   * terminal. Returns the claimed row so the verdict can be written back to its `_id`.
   */
  claim(filePath: string): Promise<ClaimedFabFile | null>;
  /** Persist the terminal verdict (and any byte-sniff-corrected mime / block reason). */
  persist(
    _id: unknown,
    patch: { moderationStatus: 'clean' | 'blocked'; mimeType?: string; blockReason?: string }
  ): Promise<void>;
  /** Release a claim back to `pending` after a transient scan failure so the row is never stranded on `scanning`. */
  release(_id: unknown): Promise<void>;
  downloadBytes(filePath: string): Promise<Buffer>;
  downloadPartialBytes(filePath: string, length: number): Promise<Buffer>;
}

/**
 * Scan knowledge files an import just wrote, OUT OF BAND and post-commit. The import stamps every
 * file `pending` (the schema default) and returns here once its transaction has committed - the
 * natural S3 ObjectCreated scan (see server/s3/objectCreated.ts) fires at upload time, before the
 * row exists inside the still-open import transaction, so it always bails; without this pass an
 * imported image would sit `pending` forever (unservable) which is why the import used to
 * mis-stamp it `clean` and bypass moderation entirely. The declared mimeType is attacker-supplied,
 * so `moderate` (moderateUploadedFile) byte-sniffs the real type: non-images resolve to `clean`
 * immediately, real image bytes take the Rekognition path. Must stay in sync with the claim +
 * verdict semantics in objectCreated.ts. Never throws - a failed scan leaves the file held.
 */
export async function moderateImportedKnowledgeFiles(args: ModerateImportedKnowledgeFilesArgs): Promise<void> {
  const {
    filePaths,
    userId,
    enabled,
    service,
    incidents,
    moderateImageOrThrow,
    moderate,
    logger,
    claim,
    persist,
    release,
    downloadBytes,
    downloadPartialBytes,
  } = args;

  for (const filePath of filePaths) {
    let claimed: ClaimedFabFile | null = null;
    try {
      claimed = await claim(filePath);
      if (!claimed) continue; // owned by a redelivered S3 event, or already terminal

      const result = await moderate({
        userId,
        fabFileId: claimed.id,
        mimeType: claimed.mimeType,
        enabled,
        service,
        incidents,
        downloadBytes: () => downloadBytes(filePath),
        downloadPartialBytes: length => downloadPartialBytes(filePath, length),
        moderateImageOrThrow,
        logger,
      });

      await persist(claimed._id, {
        moderationStatus: result.moderationStatus,
        ...(result.correctedMimeType && result.correctedMimeType !== claimed.mimeType
          ? { mimeType: result.correctedMimeType }
          : {}),
        ...(result.blockReason ? { blockReason: result.blockReason } : {}),
      });
    } catch (err) {
      // Transient failure (Rekognition throttle/5xx, download error): release the claim so the
      // file stays held ('pending') and never stuck on 'scanning'. Fail-closed: still not servable.
      if (claimed) await release(claimed._id).catch(() => undefined);
      logger.warn(
        `Failed to moderate imported knowledge file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
