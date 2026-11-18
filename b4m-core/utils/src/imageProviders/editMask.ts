import { ImageInputRejectedError } from '../imageGeneration/imageGenerationErrors';
import { readImageDimensions } from '../imageCutout';
import { imagePixelCount, MAX_IMAGE_PIXELS } from '../imageResize';
import { inputsWithRole } from './shared';
import type { ImageInputs, ResolvedImageInput } from './types';

/**
 * How a provider reads a mask: OpenAI edits where the mask is transparent, BFL Fill where it is white. Everything
 * else is kept.
 */
export type EditMaskConvention = 'transparent' | 'white';

// Below this an alpha or luminance value counts as "off"; drawn strokes are anti-aliased at their edges.
const THRESHOLD = 128;
// The share of see-through pixels that makes a mask an alpha mask; a stray translucent pixel does not.
const ALPHA_MASK_MIN_SHARE = 0.001;

type Dimensions = { width: number; height: number };

const loadJimp = async () => (await import('jimp')).Jimp;

const rejectOverBudget = (pixels: number | null, what: 'source' | 'mask') => {
  if (pixels !== null && pixels > MAX_IMAGE_PIXELS) {
    throw new ImageInputRejectedError(`The ${what} is over the ${MAX_IMAGE_PIXELS}-pixel processing limit`, {
      reason: `${what}_too_large`,
    });
  }
};

const isAlphaMask = (pixels: Uint8Array | Buffer): boolean => {
  let seeThrough = 0;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] < THRESHOLD) seeThrough++;
  return seeThrough > 0 && seeThrough >= (pixels.length / 4) * ALPHA_MASK_MIN_SHARE;
};

/**
 * A job's mask marks the area to change either with transparent pixels or, when (all but negligibly) opaque, with
 * white ones (what Studio draws). Redraws it in the provider's convention at `size`, the edit source's displayed size:
 * an upload may have been downscaled on the way in, and OpenAI refuses a mask whose size differs from the image's.
 */
export async function normalizeEditMask(
  mask: Buffer,
  size: Dimensions,
  convention: EditMaskConvention
): Promise<Buffer> {
  rejectOverBudget(imagePixelCount(mask), 'mask');
  const Jimp = await loadJimp();
  let image;
  try {
    image = await Jimp.read(mask);
  } catch {
    throw new ImageInputRejectedError('The mask image could not be read', { reason: 'mask_decode' });
  }
  const marksWithAlpha = isAlphaMask(image.bitmap.data);
  image.resize({ w: size.width, h: size.height });
  const resized = image.bitmap.data;
  for (let index = 0; index < resized.length; index += 4) {
    const luminance = 0.299 * resized[index] + 0.587 * resized[index + 1] + 0.114 * resized[index + 2];
    const edit = marksWithAlpha ? resized[index + 3] < THRESHOLD : luminance >= THRESHOLD;
    const value = edit && convention === 'white' ? 255 : 0;
    resized[index] = value;
    resized[index + 1] = value;
    resized[index + 2] = value;
    resized[index + 3] = edit && convention === 'transparent' ? 0 : 255;
  }
  return Buffer.from(await image.getBuffer('image/png'));
}

/**
 * The edit source as the provider will see it, and its size. OpenAI wants a masked source in the mask's format (PNG):
 * anything else is re-encoded here, EXIF rotation applied, so it is uploaded as-is instead of being converted (and
 * possibly shrunk) after the mask was sized to it.
 */
async function prepareSource(
  source: ResolvedImageInput,
  convention: EditMaskConvention
): Promise<{ source: ResolvedImageInput; size: Dimensions }> {
  const size = readImageDimensions(source.bytes);
  if (!size) throw new ImageInputRejectedError('The edit source image could not be read', { reason: 'source_header' });
  rejectOverBudget(size.width * size.height, 'source');
  if (convention === 'white' || source.mimeType === 'image/png') return { source, size };
  const Jimp = await loadJimp();
  let image;
  try {
    image = await Jimp.read(source.bytes);
  } catch {
    throw new ImageInputRejectedError('The edit source image could not be read', { reason: 'source_decode' });
  }
  const bytes = Buffer.from(await image.getBuffer('image/png'));
  return {
    source: { ...source, bytes, mimeType: 'image/png' },
    size: { width: image.bitmap.width, height: image.bitmap.height },
  };
}

/**
 * The inputs with the mask, when there is one, redrawn for the provider (and, for OpenAI, the source as PNG); other
 * inputs pass through untouched. Any failure is an ImageInputRejectedError: nothing has been sent yet.
 */
export async function withProviderMask(inputs: ImageInputs, convention: EditMaskConvention): Promise<ImageInputs> {
  const [mask] = inputsWithRole(inputs, 'mask');
  const [source] = inputsWithRole(inputs, 'edit_source');
  if (!mask || !source) return inputs;
  try {
    const prepared = await prepareSource(source, convention);
    const bytes = await normalizeEditMask(mask.bytes, prepared.size, convention);
    const replace = (image: ResolvedImageInput): ResolvedImageInput => {
      if (image === mask) return { ...image, bytes, mimeType: 'image/png' };
      return image === source ? prepared.source : image;
    };
    return { ...inputs, images: (inputs.images ?? []).map(replace) };
  } catch (error) {
    if (error instanceof ImageInputRejectedError) throw error;
    throw new ImageInputRejectedError('The mask could not be prepared', {
      reason: 'mask_process',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
