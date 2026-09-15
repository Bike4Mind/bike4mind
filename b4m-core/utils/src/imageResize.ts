/**
 * Server-only image downscaling (jimp). A dedicated entry, kept OUT of the barrel
 * (src/index.ts), so importing @bike4mind/utils never drags jimp into a bundle that
 * doesn't resize images (e.g. the CLI). Callers that need it import from
 * '@bike4mind/utils/imageResize' and inject it where required (see
 * processFabFilesServer, which takes this as a dependency). See issue #660.
 */
import type { Logger } from '@bike4mind/observability';
import imageSize from 'image-size';

/** Bedrock rejects images >2000px in multi-image requests. */
const MAX_IMAGE_DIMENSION_PX = 2000;

/**
 * Pixel-count ceiling for any image we fully decode with jimp. Decoding materializes a
 * width*height*4 RGBA bitmap, so a small (highly compressible) file that declares a huge canvas
 * is a decompression bomb - an 8000x8000 solid PNG is ~250KB on disk but 244MB decoded. 60 MP
 * caps the decoded bitmap near ~240MB while staying above any real photo (pro cameras ~50 MP).
 */
export const MAX_IMAGE_PIXELS = 60_000_000;

/**
 * Read an image's pixel count from its header WITHOUT decoding it (image-size parses only the
 * dimensions). Returns null when the header can't be read - a format image-size doesn't know is
 * one jimp is unlikely to decode either, so callers proceed and let jimp fail naturally.
 */
export function imagePixelCount(imageBuffer: Buffer): number | null {
  try {
    const { width, height } = imageSize(imageBuffer);
    if (typeof width === 'number' && typeof height === 'number') return width * height;
    return null;
  } catch {
    return null;
  }
}

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
  // Reject a decompression bomb before decoding: a small file can declare a huge canvas.
  // Stay lenient (this function's contract is to return a usable buffer, not throw) - pass the
  // bytes through undecoded so we never allocate the bitmap; a too-large image is rejected
  // downstream by Bedrock's own 2000px limit anyway.
  const pixels = imagePixelCount(imageBuffer);
  if (pixels !== null && pixels > MAX_IMAGE_PIXELS) {
    logger?.warn(
      `[ensureImageWithinDimensionLimit] image declares ${pixels} pixels, over the ${MAX_IMAGE_PIXELS} decode limit; passing through undecoded`
    );
    return imageBuffer;
  }
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
