import { ImageInputRejectedError } from '../imageGeneration/imageGenerationErrors';
import { readImageDimensions } from '../imageCutout';
import { MAX_IMAGE_PIXELS } from '../imageResize';
import { inputsWithRole } from './shared';
import type { ImageInputs } from './types';

/**
 * How a provider reads a mask: OpenAI edits where the mask is transparent, BFL Fill where it is white. Everything
 * else is kept.
 */
export type EditMaskConvention = 'transparent' | 'white';

// Below this an alpha or luminance value counts as "off"; drawn strokes are anti-aliased at their edges.
const THRESHOLD = 128;

const loadJimp = async () => (await import('jimp')).Jimp;

/**
 * A job's mask marks the area to change either with transparent pixels or, when fully opaque, with white ones (what
 * Studio draws). Redraws it in the provider's convention at the edit source's displayed size: an upload may have been
 * downscaled on the way in, and OpenAI refuses a mask whose size differs from the image's.
 */
export async function normalizeEditMask(mask: Buffer, source: Buffer, convention: EditMaskConvention): Promise<Buffer> {
  const size = readImageDimensions(source);
  if (!size) throw new ImageInputRejectedError('The edit source image could not be read', { reason: 'source_header' });
  if (size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new ImageInputRejectedError(`The edit source is over the ${MAX_IMAGE_PIXELS}-pixel processing limit`, {
      reason: 'source_too_large',
    });
  }
  const Jimp = await loadJimp();
  let image;
  try {
    image = await Jimp.read(mask);
  } catch {
    throw new ImageInputRejectedError('The mask image could not be read', { reason: 'mask_decode' });
  }
  const pixels = image.bitmap.data;
  let marksWithAlpha = false;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] < 255) {
      marksWithAlpha = true;
      break;
    }
  }
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

/** The inputs with the mask, when there is one, redrawn for the provider; other inputs pass through untouched. */
export async function withProviderMask(inputs: ImageInputs, convention: EditMaskConvention): Promise<ImageInputs> {
  const [mask] = inputsWithRole(inputs, 'mask');
  const [source] = inputsWithRole(inputs, 'edit_source');
  if (!mask || !source) return inputs;
  const bytes = await normalizeEditMask(mask.bytes, source.bytes, convention);
  return {
    ...inputs,
    images: (inputs.images ?? []).map(image => (image === mask ? { ...image, bytes, mimeType: 'image/png' } : image)),
  };
}
