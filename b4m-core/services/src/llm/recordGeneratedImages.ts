import type { Logger } from '@bike4mind/observability';

export interface GeneratedImageCounter {
  incrementImageCount?: (sessionId: string, count: number) => Promise<void>;
}

/**
 * Adds `count` freshly generated images to the session's imageCount (one $inc). Called by every
 * path that persists generated images onto a quest: ImageGenerationService and ImageEditService
 * (the API and in-app image models) and the image_generation / edit_image chat tools. Never throws:
 * the counter only drives a sidebar marker, so a failed write must not fail a paid generation.
 */
export async function recordGeneratedImages(
  sessions: GeneratedImageCounter | undefined,
  sessionId: string | undefined,
  count: number,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  if (!sessionId || count <= 0) return;
  if (!sessions?.incrementImageCount) {
    // Distinguishes a real wiring gap (this ToolBuilderDeps/db object never got a `sessions`
    // adapter) from the benign early returns above, which fire on every ordinary call.
    logger.warn('[recordGeneratedImages] No incrementImageCount adapter wired; imageCount not updated', {
      sessionId,
      count,
    });
    return;
  }
  try {
    await sessions.incrementImageCount(sessionId, count);
  } catch (err) {
    logger.warn('[recordGeneratedImages] Failed to increment session imageCount', { sessionId, count, err });
  }
}
