/**
 * Server-only image downscaling (jimp). A dedicated entry, kept OUT of the barrel
 * (src/index.ts), so importing @bike4mind/utils never drags jimp into a bundle that
 * doesn't resize images (e.g. the CLI). Callers that need it import from
 * '@bike4mind/utils/imageResize' and inject it where required (see
 * processFabFilesServer, which takes this as a dependency). See issue #660.
 */
import type { Logger } from '@bike4mind/observability';

/** Bedrock rejects images >2000px in multi-image requests. */
const MAX_IMAGE_DIMENSION_PX = 2000;

/**
 * Supported output MIME types for jimp's getBuffer.
 * Used to validate the detected mime before re-encoding.
 */
const JIMP_SUPPORTED_MIMES = new Set([
  'image/bmp',
  'image/x-ms-bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
]);

/**
 * Ensures an image buffer's dimensions do not exceed the max allowed pixels.
 * Bedrock rejects images >2000px in multi-image requests.
 * Returns the original buffer unchanged if already within limits.
 * Uses jimp (pure JS) instead of sharp to avoid native dependency issues in Lambda.
 */
export async function ensureImageWithinDimensionLimit(
  imageBuffer: Buffer,
  maxDimension: number = MAX_IMAGE_DIMENSION_PX,
  logger?: Logger
): Promise<Buffer> {
  try {
    // Dynamic import: jimp is only needed by server-side callers (Lambda, services).
    // A static import would cause bundlers (e.g., CLI's tsdown) to mark jimp as an
    // external dependency even though the CLI never calls this function.
    const { Jimp } = await import('jimp');
    const image = await Jimp.read(imageBuffer);
    const { width, height } = image.bitmap;

    if (width <= maxDimension && height <= maxDimension) {
      return imageBuffer;
    }

    // Scale down preserving aspect ratio so the longest edge = maxDimension
    const scale = maxDimension / Math.max(width, height);
    const newWidth = Math.floor(width * scale);
    const newHeight = Math.floor(height * scale);

    logger?.info(`[ensureImageWithinDimensionLimit] Resizing from ${width}x${height} to ${newWidth}x${newHeight}`);

    const resized = image.resize({ w: newWidth, h: newHeight });

    // Re-encode in original format if jimp supports it, otherwise fall back to PNG
    const outputMime = image.mime && JIMP_SUPPORTED_MIMES.has(image.mime) ? image.mime : 'image/png';
    // jimp's getBuffer generic constraint requires a specific mime literal union;
    // we've already validated the value against JIMP_SUPPORTED_MIMES above
    return Buffer.from(await resized.getBuffer(outputMime as 'image/png'));
  } catch (error) {
    // If resize fails (corrupt image, unsupported format), return the original buffer
    // and let the downstream API call surface any errors naturally
    logger?.warn(`[ensureImageWithinDimensionLimit] Failed to resize image, using original: ${error}`);
    return imageBuffer;
  }
}
