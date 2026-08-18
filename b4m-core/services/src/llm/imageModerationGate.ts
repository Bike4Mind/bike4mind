import { ImageModerationIncident as ImageModerationIncidentInput } from '@bike4mind/common';
import { ImageModerationBlockedError, ImageModerationService } from '@bike4mind/utils/imageModeration';
import { Logger } from '@bike4mind/observability';

/**
 * Metadata needed to record an `ImageModerationIncident` if `checkImage` blocks the image.
 * `labels` is intentionally excluded - the gate fills it in from the caught
 * `ImageModerationBlockedError` itself.
 */
export interface ImageModerationIncidentMeta {
  userId: string;
  // Optional: agent-tool callers (image_generation/edit_image LLM tools) construct this
  // from a ToolContext, which has no questId and an optional sessionId. The
  // queue-handler callers (ImageGeneration/ImageEdit) still always pass both.
  sessionId?: string;
  questId?: string;
  /** Set by uploaded-image callers; queue/tool callers omit it. */
  fabFileId?: string;
  provider: string;
  model: string;
}

export interface ModerateImageOrThrowParams {
  /** Undefined when moderation was never wired up for this caller (missing DI). */
  service: ImageModerationService | undefined;
  /** The `ImageModerationEnabled` admin setting, already resolved by the caller. */
  enabled: boolean;
  incidents: { record(input: ImageModerationIncidentInput): Promise<unknown> } | undefined;
  buffer: Buffer;
  mimeType: string;
  incidentMeta: ImageModerationIncidentMeta;
  logger: Logger;
}

/**
 * Shared moderation gate for `ImageGeneration.ts` and `ImageEdit.ts`.
 *
 * Extracted from two near-identical inline blocks so the P0 invariant - every
 * generated/edited image is checked before `storage.upload()` - has one directly
 * testable implementation instead of two copies that can silently drift.
 *
 * Behavior:
 * - Self-host (`B4M_SELF_HOST === 'true'`): skip the check and return. The gate is
 *   backed by AWS Rekognition, which a self-host install has no credentials for (its
 *   AWS_* vars are the local MinIO dummies), so the fail-closed path would otherwise
 *   throw on every image after 3 retries and mark the generation failed.
 * - `service` undefined (moderation never wired up for this caller): log a warning
 *   so a future caller that forgets DI is visible in logs, then no-op. This preserves
 *   the existing optional/backwards-compatible behavior (moderation is opt-in via DI)
 *   while making the "missing DI" case observable instead of silently invisible.
 * - `service` present but `!enabled`: skip the check entirely (admin setting off).
 * - Otherwise: call `service.checkImage(buffer, mimeType)`.
 *   - On `ImageModerationBlockedError`: attempt to record the incident. Recording is
 *     wrapped in its own try/catch - a DB failure while recording must never mask the
 *     original block error - then the original `ImageModerationBlockedError` is
 *     re-thrown unchanged.
 *   - On any other error (fail-closed, e.g. Rekognition unavailable after retries):
 *     re-throw unchanged. No incident is recorded - it wasn't a confirmed block.
 */
export async function moderateImageOrThrow(params: ModerateImageOrThrowParams): Promise<void> {
  const { service, enabled, incidents, buffer, mimeType, incidentMeta, logger } = params;

  if (process.env.B4M_SELF_HOST === 'true') {
    logger.debug(
      '[ImageModeration] self-host: Rekognition-based moderation skipped (no AWS Rekognition in self-host).'
    );
    return;
  }

  if (!service) {
    logger.warn(
      '[ImageModeration] imageModerationService is not configured — skipping moderation check for this image. ' +
        'If moderation is expected to be active, confirm the caller wires imageModerationService via DI (#9776).'
    );
    return;
  }

  if (!enabled) {
    return;
  }

  try {
    await service.checkImage(buffer, mimeType);
  } catch (err) {
    if (err instanceof ImageModerationBlockedError) {
      try {
        await incidents?.record({ ...incidentMeta, labels: err.labels });
      } catch (recordErr) {
        // A failure recording the incident must never mask the original moderation
        // block - log and continue so the block error below still surfaces.
        logger.error('[ImageModeration] Failed to record moderation incident:', recordErr);
      }
    }
    throw err; // block (or fail-closed) - caller's outer catch handles quest error state.
  }
}
