import { ImageModels, type ImageJobRequest } from '@bike4mind/common';
import {
  applyCutoutMatte,
  CUTOUT_CANVAS_SIZES,
  CUTOUT_SOURCE_MIME_TYPES,
  CutoutMatteMismatchError,
  cutoutCanvasSizeFor,
  cutoutFitsPixelBudget,
  padForMatte,
  readImageDimensions,
  type CutoutCanvasSize,
} from '@bike4mind/utils/imageCutout';
import type { ImageInputs } from '@bike4mind/utils/imageProviders';
import { createImageJobs } from './createImageJobs';
import type { CreateImageJobsDeps, CreateImageJobsInput, CreateImageJobsResult } from './types';

/**
 * The matte model. gpt-image renders a transparent background (gpt-image-2 refuses it), on a key Studio already
 * holds; only its alpha is kept (see @bike4mind/utils/imageCutout), so its rendering of the product never ships.
 */
export const CUTOUT_MODEL: ImageModels.GPT_IMAGE_1_5 = ImageModels.GPT_IMAGE_1_5;
// Medium: the matte edge is what is paid for, and low quality frays fine edges (a can's rim) for little saving.
export const CUTOUT_QUALITY = 'medium';
export const CUTOUT_PROMPT =
  'Remove the background completely. Keep the main product exactly where it is, at the same size and position, ' +
  'fully opaque. Make everything else fully transparent.';

/** The stored request for a cutout of `fileId`, rendered on `size` (the canvas closest to the source's aspect). */
export const buildCutoutRequest = (fileId: string, size: CutoutCanvasSize): ImageJobRequest => ({
  model: CUTOUT_MODEL,
  mode: 'edit',
  prompt: CUTOUT_PROMPT,
  inputs: [{ role: 'edit_source', fileId }],
  size,
  quality: CUTOUT_QUALITY,
  outputFormat: 'png',
  transparentBackground: true,
});

type CreateCutoutJobInput = Omit<CreateImageJobsInput, 'request' | 'count' | 'purpose'> & { fileId: string };

const unsupportedSource = (message: string): CreateImageJobsResult => ({
  ok: false,
  status: 422,
  code: 'unsupported_input_image',
  message,
});

/**
 * One background-removal job for the caller's image `fileId`: the same hold, settle-on-delivery and refund-on-failure
 * as any image job, and the cutout lands in Files with `derivedFrom` -> the original (role edit_source). The source
 * is checked here, before the hold, because a format the compositor cannot decode would otherwise fail after it.
 */
export async function createCutoutJob(
  input: CreateCutoutJobInput,
  deps: CreateImageJobsDeps
): Promise<CreateImageJobsResult> {
  const { fileId, ...rest } = input;
  const file = await deps.loadInputFile(input.user.id, fileId);
  if (!file) return { ok: false, status: 422, code: 'input_image_not_found', message: 'Image not found' };
  if (!CUTOUT_SOURCE_MIME_TYPES.has(file.mimeType.split(';')[0].trim().toLowerCase())) {
    return unsupportedSource('Remove background works on PNG or JPEG images');
  }
  const dimensions = readImageDimensions(file.bytes);
  const size = dimensions && cutoutCanvasSizeFor(dimensions);
  if (!dimensions || !size || !cutoutFitsPixelBudget(dimensions, size)) {
    return unsupportedSource('This image is too large or could not be read');
  }
  return createImageJobs(
    {
      ...rest,
      request: buildCutoutRequest(fileId, size),
      count: 1,
      purpose: 'cutout',
    },
    deps
  );
}

const isCanvasSize = (size: string | undefined): size is CutoutCanvasSize =>
  (CUTOUT_CANVAS_SIZES as readonly (string | undefined)[]).includes(size);

export type PreparedCutout = { source: Buffer; size: CutoutCanvasSize; inputs: ImageInputs };

/** The provider inputs for a cutout job: its source padded onto the matte canvas. Keeps the original to composite. */
export async function prepareCutoutInputs(
  request: Pick<ImageJobRequest, 'size'>,
  inputs: ImageInputs
): Promise<PreparedCutout | { error: string }> {
  const source = inputs.images?.find(image => image.role === 'edit_source');
  if (!source || !isCanvasSize(request.size)) return { error: 'cutout job has no source or canvas size' };
  try {
    const padded = await padForMatte(source.bytes, request.size);
    return {
      source: source.bytes,
      size: request.size,
      inputs: { images: [{ role: 'edit_source', bytes: padded, mimeType: 'image/png' }] },
    };
  } catch (error) {
    // A source jimp cannot decode fails the same way on every attempt, so it is a failure, not a retry.
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The delivered cutout: the source's pixels under the matte's alpha. `error` when the matte does not line up. */
export async function finishCutout(
  prepared: PreparedCutout,
  matte: Buffer
): Promise<{ bytes: Buffer; contentType: 'image/png' } | { error: string }> {
  try {
    return { bytes: await applyCutoutMatte(prepared.source, matte, prepared.size), contentType: 'image/png' };
  } catch (error) {
    if (error instanceof CutoutMatteMismatchError) return { error: error.message };
    throw error;
  }
}
