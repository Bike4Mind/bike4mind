import { IMAGE_SIZE_CONSTRAINTS, ImageModels, LEGACY_DALL_E_3_MODEL_ID } from '../models';
import { isGPTImage2Model, isGPTImageModel } from './modelHelpers';

/**
 * Exactly 'WIDTHxHEIGHT' - nothing else, no surrounding whitespace and no third segment.
 * Anchored on purpose: this module is the single source of the size rule, so a value that
 * only looks like a resolution ('1024x1024x1024') must not be measured as one.
 */
const SIZE_PATTERN = /^(\d+)x(\d+)$/;

/**
 * Splits a 'WIDTHxHEIGHT' string into numeric edges, or null when it is not a pair
 * of positive numbers. Lets callers tell a resolution that breaks a rule apart from
 * a value that expresses no resolution at all ('auto', 'wide', undefined).
 */
function parseSizeEdges(size?: string | null): { width: number; height: number } | null {
  if (typeof size !== 'string') {
    return null;
  }
  const match = SIZE_PATTERN.exec(size);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) {
    return null;
  }
  return { width, height };
}

/**
 * True when a custom gpt-image-2 resolution meets OpenAI's documented limits.
 * gpt-image-2 accepts any resolution satisfying these, not only the presets in
 * IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes, so a flat preset check would reject
 * valid custom sizes.
 */
export function satisfiesGptImage2Constraints({ width, height }: { width: number; height: number }): boolean {
  const { maxEdge, minTotalPixels, maxTotalPixels, edgeMultiple, maxAspectRatio } =
    IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.constraints;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const totalPixels = width * height;

  return (
    longEdge <= maxEdge &&
    width % edgeMultiple === 0 &&
    height % edgeMultiple === 0 &&
    longEdge / shortEdge <= maxAspectRatio &&
    totalPixels >= minTotalPixels &&
    totalPixels <= maxTotalPixels
  );
}

/**
 * Every size some legacy (pre-GPT-Image) OpenAI tier accepts. No single model accepts all
 * of them - dall-e-2 and dall-e-3 each get measured against their own list - so this is
 * only the fallback for a legacy id we cannot place in a tier. The two tiers overlap on
 * 1024x1024; the repeated entry is harmless because this list is only tested for membership.
 */
export const OPENAI_LEGACY_IMAGE_SIZES = [
  ...IMAGE_SIZE_CONSTRAINTS.DALL_E_2.sizes,
  ...IMAGE_SIZE_CONSTRAINTS.DALL_E_3.sizes,
] as const;

/**
 * True when `size` may be sent to OpenAI for `model`. This is the single source of the
 * OpenAI image size rule - generate, edit, the variation endpoint, the cost estimate and
 * the settings UI all resolve through it, so a tier changing its accepted sizes is a
 * one-line edit to IMAGE_SIZE_CONSTRAINTS rather than a hunt through retyped lists.
 *
 * gpt-image-2 takes 'auto', its presets, or any custom WIDTHxHEIGHT meeting
 * satisfiesGptImage2Constraints. The gpt-image-1 family is limited to its three fixed
 * sizes. dall-e-2 and dall-e-3 are each measured against their own tier - they share only
 * 1024x1024, so a dall-e-3 size such as 1792x1024 is correctly rejected for dall-e-2.
 *
 * A legacy id matching neither dall-e tier falls back to the union of both. That is looser
 * than any real tier, deliberately: we cannot name such a model's sizes, so we leave
 * OpenAI to reject it rather than coercing against a tier it may not belong to.
 *
 * OpenAI image models only: BFL, Gemini and xAI sizes are validated by their own adapters,
 * and passing one of those models here would measure it against the wrong list.
 */
export function isSupportedImageSize(model?: string | null, size?: string | null): boolean {
  if (typeof size !== 'string') {
    return false;
  }

  if (isGPTImage2Model(model)) {
    // A preset must never be rejected, even if the constraint numbers are later tightened.
    if (
      size === IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.autoSize ||
      (IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes as readonly string[]).includes(size)
    ) {
      return true;
    }
    const edges = parseSizeEdges(size);
    return edges !== null && satisfiesGptImage2Constraints(edges);
  }

  if (isGPTImageModel(model)) {
    return (IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes as readonly string[]).includes(size);
  }

  if (model === ImageModels.DALL_E_2) {
    return (IMAGE_SIZE_CONSTRAINTS.DALL_E_2.sizes as readonly string[]).includes(size);
  }

  if (model === LEGACY_DALL_E_3_MODEL_ID) {
    return (IMAGE_SIZE_CONSTRAINTS.DALL_E_3.sizes as readonly string[]).includes(size);
  }

  return (OPENAI_LEGACY_IMAGE_SIZES as readonly string[]).includes(size);
}

/**
 * The size to fall back to when a requested size is unsupported for `model`. Every tier
 * defaults to 1024x1024 today; the indirection keeps that a per-tier decision.
 */
export function fallbackImageSize(model?: string | null): string {
  if (isGPTImage2Model(model)) {
    return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.defaultSize;
  }
  if (isGPTImageModel(model)) {
    return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize;
  }
  if (model === LEGACY_DALL_E_3_MODEL_ID) {
    return IMAGE_SIZE_CONSTRAINTS.DALL_E_3.defaultSize;
  }
  return IMAGE_SIZE_CONSTRAINTS.DALL_E_2.defaultSize;
}

/**
 * The size the generate endpoint should send for a GPT-Image `model`, given what the
 * caller asked for. Returns the input unchanged when nothing needs correcting, so a
 * caller can compare the two to decide whether to warn.
 *
 * Absent: gpt-image-2 gets 'auto' - it is the only tier that can pick its own - and the
 * gpt-image-1 family gets its fixed default.
 *
 * Present but unsupported: replaced by the tier fallback, with one deliberate exception.
 * A gpt-image-2 value that names no resolution at all ('wide') is forwarded untouched:
 * gpt-image-2 sizing is open-ended, so an unrecognized token is left for OpenAI to
 * interpret rather than second-guessed here. The gpt-image-1 family has fixed sizes and
 * no such pass-through.
 *
 * GPT-Image tiers only - the legacy dall-e path has its own absent-size handling and
 * should gate on isSupportedImageSize directly.
 */
export function resolveGptImageGenerateSize(model?: string | null, size?: string | null): string {
  const isGptImage2 = isGPTImage2Model(model);

  if (!size) {
    return isGptImage2 ? IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.autoSize : fallbackImageSize(model);
  }
  if (isSupportedImageSize(model, size)) {
    return size;
  }
  if (isGptImage2 && parseSizeEdges(size) === null) {
    return size;
  }
  return fallbackImageSize(model);
}
