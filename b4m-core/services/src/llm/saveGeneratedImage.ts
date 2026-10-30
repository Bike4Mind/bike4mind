import type { Logger } from '@bike4mind/observability';
import type { SaveGeneratedAssetParams, SaveGeneratedAssetResult } from '../generatedAssets';

/** saveGeneratedAsset bound to the files bucket; injected by the app so these services stay storage-agnostic. */
export type SaveGeneratedAssetFn = (
  params: SaveGeneratedAssetParams,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
) => Promise<SaveGeneratedAssetResult>;

/**
 * Keeps a generated or edited image from ImageGenerationService / ImageEditService (the queue path behind
 * `/api/v1/image-*` and the in-app image models) in the user's files. Never rejects: it runs once the run has
 * been delivered and billed, so a failed save is logged and the generation still completes. Called only after the
 * pre-upload moderation gate passed; the FabFile then starts `pending` like any image upload until the
 * objectCreated scan clears it, so serving stays gated by isImageServeable.
 */
export async function saveGeneratedImage(
  save: SaveGeneratedAssetFn,
  params: SaveGeneratedAssetParams,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
): Promise<void> {
  try {
    const result = await save(params, logger);
    if (!result.saved) {
      logger.warn('[saveGeneratedImage] generated image not saved to files', { reason: result.reason });
    }
  } catch (error) {
    logger.error('[saveGeneratedImage] failed to save generated image to files', { error });
  }
}
