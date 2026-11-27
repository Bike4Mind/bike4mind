import { IMAGE_INPUT_MAX, IMAGE_MAX_EDGE, formatBytes, type ImageMediaType } from '../attachments';
import type { ImageContext, KeptImage, ToolContext } from './types';

/**
 * Raw bytes of one image a tool shows the model. Anthropic refuses an image whose base64 is over
 * 5 MB, and base64 is 4/3 of this.
 */
export const MAX_TOOL_IMAGE_BYTES = 3_750_000;

/** Nothing larger is decoded, the same limit an attachment has. */
export const MAX_TOOL_IMAGE_INPUT_BYTES = IMAGE_INPUT_MAX;

/** The long edge a capture is taken at, which is also the edge every image is fitted to. */
export const TOOL_IMAGE_MAX_EDGE = IMAGE_MAX_EDGE;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const IMAGE_FORMAT_NAMES: Record<ImageMediaType, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
};

/**
 * The image type the bytes are, by their signature and not their name: a provider rejects the
 * whole request over an image that does not decode, so a renamed text file must not be sent as one.
 */
export function sniffImageType(bytes: Buffer): ImageMediaType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** `pixels` is absent for a format the decoder cannot read, which is sent as it is. */
export type ShownImage = { ok: true; pixels?: string } | { ok: false; reason: string };

const OUTSIDE_CONVERSATION = 'images cannot be shown outside a conversation';
const NO_VISION =
  'the current model does not accept images. Tell the user, and suggest a model that reads images if they want you to see it';
const TOO_LARGE_TO_DECODE = `it is larger than the ${formatBytes(MAX_TOOL_IMAGE_INPUT_BYTES)} that can be decoded`;

/** Fit an image and attach it to this call for the model's next request, or say why it was not. */
export function showImage(context: ToolContext, bytes: Buffer, mediaType: ImageMediaType): ShownImage {
  const { images, report } = context;
  if (!images || !report) return { ok: false, reason: OUTSIDE_CONVERSATION };
  if (!images.vision) return { ok: false, reason: NO_VISION };
  if (bytes.length > MAX_TOOL_IMAGE_INPUT_BYTES) return { ok: false, reason: TOO_LARGE_TO_DECODE };

  const fitted = fitToolImage(images, bytes, mediaType);
  if (!fitted.ok) return fitted;
  report.image(fitted.bytes, fitted.mediaType);
  return { ok: true, ...(fitted.pixels ? { pixels: fitted.pixels } : {}) };
}

/**
 * showImage, plus a copy of the same fitted image kept on this call's row for the user - kept
 * even when the model cannot read images. `kept` is false when there was nowhere to keep it or
 * the image did not decode.
 */
export async function showAndKeepImage(
  context: ToolContext,
  bytes: Buffer,
  mediaType: ImageMediaType,
  caption: string
): Promise<{ shown: ShownImage; kept: boolean }> {
  const { images, report } = context;
  if (!images || !report) return { shown: { ok: false, reason: OUTSIDE_CONVERSATION }, kept: false };
  if (!images.vision && !images.keep) return { shown: { ok: false, reason: NO_VISION }, kept: false };
  if (bytes.length > MAX_TOOL_IMAGE_INPUT_BYTES) {
    return { shown: { ok: false, reason: images.vision ? TOO_LARGE_TO_DECODE : NO_VISION }, kept: false };
  }

  const fitted = fitToolImage(images, bytes, mediaType);
  const media = fitted.ok && images.keep ? await images.keep(bytes, fitted, caption) : undefined;
  if (media) report.media(media);
  const kept = media !== undefined;
  if (!images.vision) return { shown: { ok: false, reason: NO_VISION }, kept };
  if (!fitted.ok) return { shown: fitted, kept };
  report.image(fitted.bytes, fitted.mediaType);
  return { shown: { ok: true, ...(fitted.pixels ? { pixels: fitted.pixels } : {}) }, kept };
}

/** Fit an image under the size a tool image may be sent at; shared with the replay of generated images. */
export function fitToolImage(
  images: ImageContext,
  bytes: Buffer,
  mediaType: ImageMediaType
): ({ ok: true; pixels?: string } & KeptImage) | { ok: false; reason: string } {
  const prepared = images.prepare(bytes, mediaType, MAX_TOOL_IMAGE_BYTES);
  if (prepared) {
    const read = `${prepared.sourceWidth}x${prepared.sourceHeight}`;
    const sent = `${prepared.width}x${prepared.height}`;
    const pixels = read === sent ? read : `${read}, shown to you at ${sent}`;
    return {
      ok: true,
      bytes: prepared.bytes,
      mediaType: prepared.mediaType,
      pixels,
      width: prepared.width,
      height: prepared.height,
    };
  }
  // nativeImage decodes PNG and JPEG everywhere, so either one it refused is broken or too big to fit.
  if (mediaType === 'image/png' || mediaType === 'image/jpeg') {
    return { ok: false, reason: `it could not be decoded, or not reduced under ${formatBytes(MAX_TOOL_IMAGE_BYTES)}` };
  }
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `it is over the ${formatBytes(MAX_TOOL_IMAGE_BYTES)} that can be shown, and a ${IMAGE_FORMAT_NAMES[mediaType]} cannot be downscaled here`,
    };
  }
  return { ok: true, bytes, mediaType };
}
